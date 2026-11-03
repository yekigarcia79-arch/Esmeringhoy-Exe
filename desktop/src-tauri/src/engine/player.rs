use crate::api::ApiClient;
use crate::cache::TrackCache;
use anyhow::{anyhow, Context, Result};
use rodio::{Decoder, DeviceSinkBuilder, MixerDeviceSink, Player, Source};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::fs::File;
use std::io::BufReader;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use crate::engine::stream::{spawn_decoder, Ring, RingSource, Tail, TailFile, PREBUFFER_BYTES};

pub const TICK_MS: u64 = 400;
const STREAM_WHILE_DOWNLOADING: bool = false;
pub const POSITION_EVENT: &str = "player:position";
pub const LOADING_EVENT: &str = "player:loading";
pub const TRACK_EVENT: &str = "player:track-changed";
pub const ERROR_EVENT: &str = "player:error";
pub const IDLE_EVENT: &str = "player:idle";

#[derive(Clone, Serialize, Deserialize)]
pub struct PlayingTrack {
    #[serde(rename = "videoId")]
    pub video_id: String,
    pub title: String,
    #[serde(default)]
    pub artist: String,
    #[serde(default)]
    pub duration: f64,
}

impl PlayingTrack {
    pub fn from_snapshot_current(current: &serde_json::Value) -> Option<Self> {
        let t = current.as_object()?;
        let video_id = t.get("videoId")?.as_str()?.to_string();
        if !player_util::valid_id(&video_id) {
            return None;
        }
        Some(Self {
            video_id,
            title: t.get("title").and_then(|v| v.as_str()).unwrap_or("Unknown").to_string(),
            artist: t.get("artist").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            duration: t
                .get("duration")
                .or_else(|| t.get("durationSec"))
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0),
        })
    }
}

#[derive(Clone, Serialize)]
pub struct EngineStateView {
    pub state: &'static str,
    pub pos: f64,
    pub duration: f64,
    pub volume: f32,
    pub track: Option<PlayingTrack>,
}

struct LoadCtl {
    loading: bool,
    pending: Option<PlayingTrack>,
}

pub struct Engine {
    device_sink: MixerDeviceSink,
    player: Mutex<Option<Player>>,
    current: Mutex<Option<PlayingTrack>>,
    duration_hint: Mutex<Duration>,
    generation: AtomicU64,
    ctl: Mutex<LoadCtl>,
    volume: Mutex<f32>,
    cancel: Mutex<Option<Arc<AtomicBool>>>,
    tail: Mutex<Option<Arc<Tail>>>,
    streaming: AtomicBool,
}

impl Engine {
    pub fn new(volume: f32) -> Result<Self> {
        let mut device_sink =
            DeviceSinkBuilder::open_default_sink().context("no audio output device")?;
        device_sink.log_on_drop(false);
        Ok(Self {
            device_sink,
            player: Mutex::new(None),
            current: Mutex::new(None),
            duration_hint: Mutex::new(Duration::ZERO),
            generation: AtomicU64::new(0),
            ctl: Mutex::new(LoadCtl { loading: false, pending: None }),
            volume: Mutex::new(volume.clamp(0.0, 1.0)),
            cancel: Mutex::new(None),
            tail: Mutex::new(None),
            streaming: AtomicBool::new(false),
        })
    }

    pub fn volume(&self) -> f32 {
        *self.volume.lock().unwrap()
    }

    pub fn set_volume(&self, v: f32) {
        let v = v.clamp(0.0, 1.0);
        *self.volume.lock().unwrap() = v;
        if let Some(p) = self.player.lock().unwrap().as_ref() {
            p.set_volume(v);
        }
    }

    pub fn current(&self) -> Option<PlayingTrack> {
        self.current.lock().unwrap().clone()
    }

    pub fn is_loading(&self) -> bool {
        self.ctl.lock().unwrap().loading
    }

    pub fn state(&self) -> EngineStateView {
        let (state, pos, dur) = {
            let player = self.player.lock().unwrap();
            let dur = self.duration_hint.lock().unwrap().as_secs_f64();
            match player.as_ref() {
                None => ("idle", 0.0, dur),
                Some(p) => {
                    let pos = p.get_pos().as_secs_f64().min(dur);
                    (if p.is_paused() { "paused" } else { "playing" }, pos, dur)
                }
            }
        };
        EngineStateView {
            state: if self.is_loading() { "loading" } else { state },
            pos,
            duration: dur,
            volume: self.volume(),
            track: self.current(),
        }
    }

    pub async fn load_and_play(
        self: &Arc<Self>,
        app: &AppHandle,
        api: &ApiClient,
        cache: &Arc<TrackCache>,
        track: PlayingTrack,
    ) -> Result<()> {
        {
            let mut ctl = self.ctl.lock().unwrap();
            if ctl.loading {
                ctl.pending = Some(track);
                return Ok(());
            }
            ctl.loading = true;
        }

        let mut cur = Some(track);
        loop {
            let Some(t) = cur.take() else { break };
            let result = self.load_inner(app, api, cache, t).await;
            if let Err(e) = &result {
                let _ = app.emit(ERROR_EVENT, json!({ "message": e.to_string() }));
            }
            let mut ctl = self.ctl.lock().unwrap();
            match ctl.pending.take() {
                Some(next) => cur = Some(next),
                None => {
                    ctl.loading = false;
                    return Ok(());
                }
            }
        }
        Ok(())
    }

    async fn load_inner(
        self: &Arc<Self>,
        app: &AppHandle,
        api: &ApiClient,
        cache: &Arc<TrackCache>,
        track: PlayingTrack,
    ) -> Result<()> {
        let _ = app.emit(LOADING_EVENT, json!({ "videoId": track.video_id, "progress": -1.0 }));

        if let Some(cancel) = self.cancel.lock().unwrap().take() {
            cancel.store(true, Ordering::SeqCst);
        }

        let gen = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let dur = match cache.lookup(&track.video_id) {
            Some(path) => match self.open_player(app, api, cache, &track, &path, gen) {
                Ok(d) => d,
                Err(_) => {
                    cache.remove(&track.video_id);
                    self.fetch_then_play(app, api, cache, &track, gen).await?
                }
            },
            None => {
                if STREAM_WHILE_DOWNLOADING {
                    self.stream_track(app, api, cache, &track, gen).await?
                } else {
                    self.fetch_then_play(app, api, cache, &track, gen).await?
                }
            }
        };
        *self.current.lock().unwrap() = Some(track.clone());
        *self.duration_hint.lock().unwrap() = dur;
        let _ = app.emit(TRACK_EVENT, json!({ "track": track, "duration": dur.as_secs_f64() }));
        Ok(())
    }

    async fn fetch_then_play(
        self: &Arc<Self>,
        app: &AppHandle,
        api: &ApiClient,
        cache: &Arc<TrackCache>,
        track: &PlayingTrack,
        gen: u64,
    ) -> Result<Duration> {
        let dest = cache.path_for(&track.video_id, "m4a");
        let tail = Tail::new();
        let bytes = self.download_streaming(app, api, track, &dest, tail).await?;
        cache.record(&track.video_id, "m4a", bytes);
        self.open_player(app, api, cache, track, &dest, gen)
    }

    async fn stream_track(
        self: &Arc<Self>,
        app: &AppHandle,
        api: &ApiClient,
        cache: &Arc<TrackCache>,
        track: &PlayingTrack,
        gen: u64,
    ) -> Result<Duration> {
        let dest = cache.path_for(&track.video_id, "m4a");
        let part = dest.with_extension("part");
        let _ = tokio::fs::remove_file(&part).await;

        let tail = Tail::new();
        let cancel = Arc::new(AtomicBool::new(false));
        *self.cancel.lock().unwrap() = Some(Arc::clone(&cancel));
        *self.tail.lock().unwrap() = Some(Arc::clone(&tail));
        self.streaming.store(true, Ordering::SeqCst);

        {
            let engine = Arc::clone(self);
            let app = app.clone();
            let api = api.clone();
            let cache = Arc::clone(cache);
            let track = track.clone();
            let dest = dest.clone();
            let tail = Arc::clone(&tail);
            tauri::async_runtime::spawn(async move {
                match engine.download_streaming(&app, &api, &track, &dest, Arc::clone(&tail)).await {
                    Ok(bytes) => {
                        cache.record(&track.video_id, "m4a", bytes);
                        tail.finish();
                    }
                    Err(e) => {
                        let _ = tokio::fs::remove_file(dest.with_extension("part")).await;
                        tail.fail(e.to_string());
                    }
                }
            });
        }

        let wait_until = std::time::Instant::now() + Duration::from_secs(6);
        while tail.available() < PREBUFFER_BYTES && !tail.is_done() && std::time::Instant::now() < wait_until {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let ready = tail.available() >= PREBUFFER_BYTES || tail.is_done();
        if let Some(e) = tail.error() {
            return Err(anyhow!(e));
        }
        if !ready || tail.is_done() {
            let deadline = std::time::Instant::now() + Duration::from_secs(180);
            while !tail.is_done() && std::time::Instant::now() < deadline {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            if let Some(e) = tail.error() {
                return Err(anyhow!(e));
            }
            if !tail.is_done() {
                return Err(anyhow!("the download stalled"));
            }
            return self.open_player(app, api, cache, track, &dest, gen);
        }

        let file = TailFile::open(&part, Arc::clone(&tail)).context("opening the stream")?;
        let decoder = match Decoder::new(file) {
            Ok(d) => d,
            Err(e) => {
                let deadline = std::time::Instant::now() + Duration::from_secs(180);
                while !tail.is_done() && std::time::Instant::now() < deadline {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                if let Some(err) = tail.error() {
                    return Err(anyhow!(err));
                }
                if !tail.is_done() {
                    return Err(anyhow!("the download stalled ({e})"));
                }
                return self.open_player(app, api, cache, track, &dest, gen);
            }
        };
        let ring = Ring::new(decoder.channels(), decoder.sample_rate());
        spawn_decoder(decoder, Arc::clone(&ring), cancel);

        let player = Player::connect_new(self.device_sink.mixer());
        player.set_volume(*self.volume.lock().unwrap());
        player.append(RingSource::new(ring));
        player.play();
        *self.player.lock().unwrap() = Some(player);

        let duration = Duration::from_secs_f64(track.duration.max(0.0));
        self.spawn_ticker(app, api, cache, track, gen);
        Ok(duration)
    }

    async fn download_streaming(
        &self,
        app: &AppHandle,
        api: &ApiClient,
        track: &PlayingTrack,
        dest: &Path,
        tail: Arc<Tail>,
    ) -> Result<u64> {
        let video_id = track.video_id.as_str();

        if let Ok(res) = crate::youtube::resolve(video_id).await {
            let mut last_emit = 0u64;
            let follow = Arc::clone(&tail);
            let bytes = api
                .download_ranged(&res.url, dest, |written, total| {
                    follow.advance(written);
                    if written.saturating_sub(last_emit) >= 256 * 1024 {
                        last_emit = written;
                        let _ = app.emit(
                            LOADING_EVENT,
                            json!({
                                "videoId": video_id,
                                "progress": total.map(|t| written as f64 / t as f64).unwrap_or(-1.0),
                            }),
                        );
                    }
                })
                .await?;
            return Ok(bytes);
        }

        let mut last_emit = 0u64;
        let follow = Arc::clone(&tail);
        let bytes = api
            .download_ranged(
                &format!("/api/stream/{video_id}?codec=aac"),
                dest,
                |written, total| {
                    follow.advance(written);
                    if written.saturating_sub(last_emit) >= 256 * 1024 {
                        last_emit = written;
                        let _ = app.emit(
                            LOADING_EVENT,
                            json!({
                                "videoId": video_id,
                                "progress": total.map(|t| written as f64 / t as f64).unwrap_or(-1.0),
                            }),
                        );
                    }
                },
            )
            .await?;
        Ok(bytes)
    }

    fn spawn_ticker(
        self: &Arc<Self>,
        app: &AppHandle,
        api: &ApiClient,
        cache: &Arc<TrackCache>,
        track: &PlayingTrack,
        gen: u64,
    ) {
        let engine = Arc::clone(self);
        let expected = track.video_id.clone();
        let app = app.clone();
        let api = api.clone();
        let cache = Arc::clone(cache);
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(TICK_MS)).await;

                if engine.generation.load(Ordering::SeqCst) != gen {
                    return;
                }

                let (done, pos, dur) = {
                    let player = engine.player.lock().unwrap();
                    match player.as_ref() {
                        None => (false, 0.0, 0.0),
                        Some(p) => {
                            let dur = engine.duration_hint.lock().unwrap().as_secs_f64();
                            let pos = p.get_pos().as_secs_f64().min(dur);
                            let done = p.empty() || (dur > 1.0 && pos >= dur - 0.15);
                            (done, pos, dur)
                        }
                    }
                };
                let _ = app.emit(
                    POSITION_EVENT,
                    json!({ "pos": pos, "duration": dur, "state": engine.state().state }),
                );

                let still = engine
                    .current()
                    .map(|t| t.video_id == expected)
                    .unwrap_or(false);
                if !still {
                    return;
                }
                if done {
                    engine.on_track_ended(&app, &api, &cache, gen).await;
                    return;
                }
            }
        });

    }

    fn open_player(
        self: &Arc<Self>,
        app: &AppHandle,
        api: &ApiClient,
        cache: &Arc<TrackCache>,
        track: &PlayingTrack,
        path: &Path,
        gen: u64,
    ) -> Result<Duration> {
        self.streaming.store(false, Ordering::SeqCst);
        *self.tail.lock().unwrap() = None;

        let file = File::open(path).with_context(|| format!("opening {}", path.display()))?;
        let decoder = Decoder::new(BufReader::new(file))
            .context("could not decode that track (unsupported format)")?;
        let duration = decoder
            .total_duration()
            .unwrap_or(Duration::from_secs_f64(track.duration.max(0.0)));

        let player = Player::connect_new(self.device_sink.mixer());
        player.set_volume(*self.volume.lock().unwrap());
        player.append(decoder);
        player.play();
        *self.player.lock().unwrap() = Some(player);

        self.spawn_ticker(app, api, cache, track, gen);
        Ok(duration)
    }

    async fn on_track_ended(
        self: &Arc<Self>,
        app: &AppHandle,
        api: &ApiClient,
        cache: &Arc<TrackCache>,
        gen: u64,
    ) {
        let res = api
            .call("POST", "/api/cmd", Some(json!({ "cmd": "ended" })))
            .await;
        if self.generation.load(Ordering::SeqCst) != gen {
            return;
        }
        match res {
            Ok(r) if r.ok() => match r.json.get("current").and_then(PlayingTrack::from_snapshot_current) {
                Some(track) => {
                    if let Err(e) = self.load_and_play(app, api, cache, track).await {
                        let _ = app.emit(ERROR_EVENT, json!({ "message": e.to_string() }));
                    }
                }
                None => {
                    self.stop();
                    let _ = app.emit(IDLE_EVENT, json!({ "reason": "queue-exhausted" }));
                }
            },
            Ok(r) => {
                let _ = app.emit(
                    ERROR_EVENT,
                    json!({ "message": format!("the server refused the track end (HTTP {})", r.status) }),
                );
                self.stop();
            }
            Err(e) => {
                let _ = app.emit(ERROR_EVENT, json!({ "message": format!("network error: {e}") }));
                self.stop();
            }
        }
    }

    pub fn toggle_pause(&self) -> Option<bool> {
        let player = self.player.lock().unwrap();
        player.as_ref().map(|p| {
            if p.is_paused() {
                p.play();
                false
            } else {
                p.pause();
                true
            }
        })
    }

    pub fn streaming_tail(&self) -> Option<Arc<Tail>> {
        if self.streaming.load(Ordering::SeqCst) {
            self.tail.lock().unwrap().clone()
        } else {
            None
        }
    }

    pub fn seek(&self, secs: f64) -> Result<()> {
        let player = self.player.lock().unwrap();
        let p = player.as_ref().ok_or_else(|| anyhow!("nothing is playing"))?;
        p.try_seek(Duration::from_secs_f64(secs.max(0.0)))
            .map_err(|e| anyhow!("seek failed: {e}"))
    }

    pub fn stop(&self) {
        if let Some(cancel) = self.cancel.lock().unwrap().take() {
            cancel.store(true, Ordering::SeqCst);
        }
        *self.tail.lock().unwrap() = None;
        self.streaming.store(false, Ordering::SeqCst);
        if let Some(p) = self.player.lock().unwrap().take() {
            p.stop();
        }
        *self.current.lock().unwrap() = None;
        *self.duration_hint.lock().unwrap() = Duration::ZERO;
        self.generation.fetch_add(1, Ordering::SeqCst);
    }
}

pub mod player_util {
    pub fn valid_id(id: &str) -> bool {
        !id.is_empty()
            && id.len() <= 20
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    }
}
