//! Smart queue pre-downloading.
//!
//! When the currently playing track reaches its final seconds, the frontend
//! hands the upcoming queue over to this module. Tracks are fetched in queue
//! order (the immediate next track first) with a small concurrency budget,
//! written straight into the shared [`TrackCache`] (so playback finds them
//! there without a new download), and reported through `preload:status`
//! events for the queue UI.
//!
//! Failure modes: cached tracks are skipped, the cache limit is respected,
//! and downloading drops the moment a track leaves the queue.

use crate::api::ApiClient;
use crate::cache::TrackCache;
use crate::engine::PlayingTrack;
use serde::Serialize;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

pub const PRELOAD_STATUS_EVENT: &str = "preload:status";
const CONCURRENCY: usize = 2;
const MIN_FREE_CACHE: u64 = 64 * 1024 * 1024; // 64 MB headroom before we stop fetching

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PreloadStatus {
    Waiting,
    Downloading,
    Done,
    Cached,
    Failed,
    Full,
}

struct Inner {
    wanted: Vec<String>,
    tracks: HashMap<String, PlayingTrack>,
    active: HashSet<String>,
    cancel: HashMap<String, Arc<AtomicBool>>,
    status: HashMap<String, PreloadStatus>,
}

pub struct Preloader {
    inner: Mutex<Inner>,
    api: Arc<ApiClient>,
    cache: Arc<TrackCache>,
}

#[derive(Serialize)]
pub struct PreloadEntry {
    #[serde(rename = "videoId")]
    pub video_id: String,
    pub status: PreloadStatus,
}

impl Preloader {
    pub fn new(api: Arc<ApiClient>, cache: Arc<TrackCache>) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner {
                wanted: Vec::new(),
                tracks: HashMap::new(),
                active: HashSet::new(),
                cancel: HashMap::new(),
                status: HashMap::new(),
            }),
            api,
            cache,
        })
    }

    pub fn status_snapshot(&self) -> Vec<PreloadEntry> {
        let inner = self.inner.lock().unwrap();
        inner
            .status
            .iter()
            .map(|(video_id, status)| PreloadEntry { video_id: video_id.clone(), status: *status })
            .collect()
    }

    /// Replace the target list. Called by the frontend when the 40-second
    /// window opens and whenever the queue changes while inside it. Tracks
    /// already downloading that left the queue are cancelled; untouched
    /// in-flight work is kept.
    pub fn set_targets(self: &Arc<Self>, app: AppHandle, tracks: Vec<PlayingTrack>) {
        let mut inner = self.inner.lock().unwrap();

        let wanted: Vec<String> = tracks
            .iter()
            .filter(|t| !t.video_id.is_empty())
            .map(|t| t.video_id.clone())
            .take(8)
            .collect();

        if wanted == inner.wanted {
            return; // already up to date
        }

        // Cancel anything in flight that is no longer wanted.
        let keep: HashSet<&String> = wanted.iter().collect();
        let dropped: Vec<String> = inner
            .active
            .iter()
            .filter(|id| !keep.contains(*id))
            .cloned()
            .collect();
        for id in dropped {
            if let Some(flag) = inner.cancel.get(&id) {
                flag.store(true, Ordering::SeqCst);
            }
            inner.active.remove(&id);
            inner.status.insert(id, PreloadStatus::Waiting);
        }

        inner.wanted = wanted;
        inner.tracks = tracks
            .into_iter()
            .filter(|t| !t.video_id.is_empty())
            .map(|t| (t.video_id.clone(), t))
            .collect();

        // Classify against the cache.
        for id in inner.wanted.clone() {
            let cached = self.cache.is_cached(&id, "m4a");
            let status = if cached { PreloadStatus::Cached } else { PreloadStatus::Waiting };
            inner.status.insert(id, status);
        }
        let wanted_set: HashSet<String> = inner.wanted.iter().cloned().collect();
        inner.status.retain(|id, _| wanted_set.contains(id));

        // Respect the cache cap with headroom.
        let free = self.cache.cap().saturating_sub(self.cache.total_bytes());
        if free < MIN_FREE_CACHE {
            for id in inner.wanted.clone() {
                if inner.status.get(&id) == Some(&PreloadStatus::Waiting) {
                    inner.status.insert(id, PreloadStatus::Full);
                }
            }
            drop(inner);
            emit_all(&app, self);
            return;
        }

        drop(inner);
        self.pump(app.clone());
        emit_all(&app, self);
    }

    fn on_job_done(self: &Arc<Self>, app: AppHandle, video_id: &str, status: PreloadStatus) {
        {
            let mut inner = self.inner.lock().unwrap();
            inner.active.remove(video_id);
            inner.cancel.remove(video_id);
            if inner.wanted.contains(&video_id.to_string()) {
                inner.status.insert(video_id.to_string(), status);
            }
        }
        self.pump(app.clone());
        emit_all(&app, self);
    }

    fn pump(self: &Arc<Self>, app: AppHandle) {
        loop {
            let (_id, track, ext, cancel) = {
                let mut inner = self.inner.lock().unwrap();
                if inner.active.len() >= CONCURRENCY {
                    return;
                }
                let next = inner
                    .wanted
                    .iter()
                    .find(|id| {
                        !inner.active.contains(*id)
                            && matches!(inner.status.get(*id), Some(PreloadStatus::Waiting))
                    })
                    .cloned();
                let Some(id) = next else { return };
                let Some(track) = inner.tracks.get(&id).cloned() else { return };
                let cancel = Arc::new(AtomicBool::new(false));
                inner.active.insert(id.clone());
                inner.cancel.insert(id.clone(), Arc::clone(&cancel));
                inner.status.insert(id.clone(), PreloadStatus::Downloading);
                (id, track, "m4a".to_string(), cancel)
            };
            let preloader = Arc::clone(self);
            let app2 = app.clone();
            tauri::async_runtime::spawn(async move {
                run_job(preloader, app2, track, &ext, cancel).await;
            });
        }
    }
}

async fn run_job(
    preloader: Arc<Preloader>,
    app: AppHandle,
    track: PlayingTrack,
    ext: &str,
    cancel: Arc<AtomicBool>,
) {
    let id = track.video_id.clone();
    let dest = preloader.cache.path_for(&id, ext);
    let result = download_track(&preloader, &id, &dest, &cancel).await;

    match result {
        Ok(bytes) => {
            if !valid_download(&dest) {
                let _ = tokio::fs::remove_file(&dest).await;
                eprintln!("[preload] {id}: invalid {ext} download discarded");
                preloader.on_job_done(app, &id, PreloadStatus::Failed);
                return;
            }
            preloader.cache.record(&id, ext, bytes);
            preloader.on_job_done(app, &id, PreloadStatus::Done);
        }
        Err(e) => {
            if cancel.load(Ordering::SeqCst) {
                preloader.on_job_done(app, &id, PreloadStatus::Waiting);
                return;
            }
            let _ = tokio::fs::remove_file(dest.with_extension("part")).await;
            eprintln!("[preload] download failed for {id} ({e})");
            preloader.on_job_done(app, &id, PreloadStatus::Failed);
        }
    }
}

async fn download_track(
    preloader: &Preloader,
    id: &str,
    dest: &std::path::Path,
    cancel: &Arc<AtomicBool>,
) -> anyhow::Result<u64> {
    match crate::youtube::resolve(id).await {
        Ok(res) => {
            preloader
                .api
                .download_ranged(&res.url, dest, |_, _| {}, Some(Arc::clone(cancel)))
                .await
        }
        Err(_) => {
            preloader
                .api
                .download_ranged(&format!("/api/stream/{id}?codec=aac"), dest, |_, _| {}, Some(Arc::clone(cancel)))
                .await
        }
    }
}

fn valid_download(path: &std::path::Path) -> bool {
    use std::io::Read;
    let Ok(mut f) = std::fs::File::open(path) else { return false };
    let mut head = [0u8; 12];
    let n = f.read(&mut head).unwrap_or(0);
    n >= 8 && head[4..8] == *b"ftyp"
}

fn emit_all(app: &AppHandle, preloader: &Arc<Preloader>) {
    for entry in preloader.status_snapshot() {
        let _ = app.emit(
            PRELOAD_STATUS_EVENT,
            json!({ "videoId": entry.video_id, "status": entry.status }),
        );
    }
}
