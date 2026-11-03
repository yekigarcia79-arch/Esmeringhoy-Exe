//! The audio engine: download → Symphonia decode (via rodio) → cpal output.
//!
//! Playback strategy: download the whole track to the local cache (a few
//! MB), decode from the file. Seeking is then a file seek — instant and
//! accurate — and repeat plays are served from disk with no network.

use crate::api::ApiClient;
use crate::cache::TrackCache;
use anyhow::{anyhow, Context, Result};
use rodio::{Decoder, DeviceSinkBuilder, MixerDeviceSink, Player, Source};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub const TICK_MS: u64 = 400;
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
    pub duration: f64, // seconds, from the server snapshot when present
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
            duration: t.get("duration").and_then(|v| v.as_f64()).unwrap_or(0.0),
        })
    }
}

#[derive(Clone, Serialize)]
pub struct EngineStateView {
    pub state: &'static str, // "idle" | "loading" | "playing" | "paused"
    pub pos: f64,
    pub duration: f64,
    pub volume: f32,
    pub track: Option<PlayingTrack>,
}

struct LoadCtl {
    loading: bool,
    /// A load requested while another is still downloading — last click
    /// wins; it runs as soon as the current load settles.
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

    /// Play a track, downloading it first if it is not in the cache. The
    /// server already decided *that* this track plays; the engine makes the
    /// bytes audible. If a previous load is still running, the newer request
    /// waits in the pending slot and supersedes it when it settles — the
    /// user never loses a click, and rapid clicks resolve last-click-wins.
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
                // The loader running right now will pick this up next —
                // last click wins, nothing is lost or duplicated.
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
            // One critical section decides: run the next pending load, or
            // stand down — no request can slip through the gap.
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

        let local = match cache.lookup(&track.video_id) {
            Some(p) => p,
            None => self.download_track(app, api, cache, &track.video_id).await?,
        };

        let gen = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let dur = self.open_player(app, api, cache, &track, &local, gen)?;
        *self.current.lock().unwrap() = Some(track.clone());
        *self.duration_hint.lock().unwrap() = dur;
        let _ = app.emit(TRACK_EVENT, json!({ "track": track, "duration": dur.as_secs_f64() }));
        Ok(())
    }

    async fn download_track(
        &self,
        app: &AppHandle,
        api: &ApiClient,
        cache: &Arc<TrackCache>,
        video_id: &str,
    ) -> Result<PathBuf> {
        // The plain path needs no minting: download the whole file, then
        // decode from disk. Two sources, same sink: 1) direct resolution
        // from this machine's egress (the Cloudflare Workers' datacenter
        // IPs are bot-flagged by YouTube → playabilityStatus=LOGIN_REQUIRED);
        // 2) the backend relay as a fallback for resolutions the Workers
        //    already hold cached.
        let dest = cache.path_for(video_id, "m4a");

        // 1) Direct resolution, bytes Google → this machine.
        match crate::youtube::resolve(video_id).await {
            Ok(res) => {
                let mut last_emit = 0u64;
                let bytes = api
                    .download_url(&res.url, &dest, |written, total| {
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
                cache.record(video_id, "m4a", bytes);
                return Ok(dest);
            }
            Err(_) => {
                // Fall through to the relay silently; if that also fails,
                // load_and_play surfaces the error like any other failure.
            }
        }

        // 2) Fallback: backend relay.
        let mut last_emit = 0u64;
        let bytes = api
            .download_to_file(
                &format!("/api/stream/{video_id}?codec=aac"),
                &dest,
                |written, total| {
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
        cache.record(video_id, "m4a", bytes);
        Ok(dest)
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
        let file = File::open(path).with_context(|| format!("opening {}", path.display()))?;
        let decoder = Decoder::new(BufReader::new(file))
            .context("could not decode that track (unsupported format)")?;
        let duration = decoder
            .total_duration()
            .unwrap_or(Duration::from_secs_f64(track.duration.max(0.0)));

        // A new Player per track: dropping the old one stops the old track.
        let player = Player::connect_new(self.device_sink.mixer());
        player.set_volume(*self.volume.lock().unwrap());
        player.append(decoder);
        player.play();
        *self.player.lock().unwrap() = Some(player);

        // Progress ticker + end-of-track detection. Exits when another
        // track is loaded (generation bumped) or the app stops playback.
        let engine = Arc::clone(self);
        let expected = track.video_id.clone();
        let app = app.clone();
        let api = api.clone();
        let cache = Arc::clone(cache);
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(TICK_MS)).await;

                if engine.generation.load(Ordering::SeqCst) != gen {
                    return; // a newer track owns the sink
                }

                let (done, pos, dur) = {
                    let player = engine.player.lock().unwrap();
                    match player.as_ref() {
                        None => (false, 0.0, 0.0),
                        Some(p) => {
                            let dur = engine.duration_hint.lock().unwrap().as_secs_f64();
                            let pos = p.get_pos().as_secs_f64().min(dur);
                            let done = p.empty() || pos >= dur - 0.15;
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

        Ok(duration)
    }

    /// The track finished: tell the server (it decides what plays next),
    /// then load whatever it picks — or go idle.
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
        // A newer track claimed the sink while we were on the wire: stand down.
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
                    // Queue exhausted and radio produced nothing — go idle.
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

    pub fn seek(&self, secs: f64) -> Result<()> {
        let player = self.player.lock().unwrap();
        let p = player.as_ref().ok_or_else(|| anyhow!("nothing is playing"))?;
        p.try_seek(Duration::from_secs_f64(secs.max(0.0)))
            .map_err(|e| anyhow!("seek failed: {e}"))
    }

    pub fn stop(&self) {
        if let Some(p) = self.player.lock().unwrap().take() {
            p.stop();
        }
        *self.current.lock().unwrap() = None;
        *self.duration_hint.lock().unwrap() = Duration::ZERO;
        self.generation.fetch_add(1, Ordering::SeqCst);
    }
}

/// Small id helpers shared with the API layer.
pub mod player_util {
    pub fn valid_id(id: &str) -> bool {
        !id.is_empty()
            && id.len() <= 20
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    }
}
