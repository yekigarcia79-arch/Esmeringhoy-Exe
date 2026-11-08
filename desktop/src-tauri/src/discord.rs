use crate::engine::PlayingTrack;
use crate::state::Prefs;
use discord_rich_presence::{
    activity::{Activity, Assets, Timestamps},
    DiscordIpc, DiscordIpcClient,
};
use serde::Serialize;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

/// Emitted whenever the connection status changes, so the settings sheet can
/// update without polling.
pub const DISCORD_STATUS_EVENT: &str = "discord:status";

/// Discord's IPC pipe is only available while the Discord desktop app is
/// running. Retry no more often than this so a closed Discord does not turn
/// into a busy loop (all of this runs on the RPC thread, never the UI thread).
const RECONNECT_BACKOFF: Duration = Duration::from_secs(10);

/// Re-send the current activity periodically. This doubles as a liveness
/// check: if Discord was closed, the write fails and we reconnect later.
const REFRESH_INTERVAL: Duration = Duration::from_secs(15);

/// How long the RPC thread sleeps when there is nothing to publish.
const IDLE_WAIT: Duration = Duration::from_secs(5);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordSettings {
    pub enabled: bool,
    pub client_id: String,
    pub large_image_key: String,
    pub small_image_key: String,
    pub status: String,
}

/// Fully prepared Rich Presence payload. Building it is cheap; publishing it
/// is what can block, so the payload is handed to the RPC thread.
#[derive(Clone)]
struct DesiredActivity {
    title: String,
    artist: String,
    album: String,
    large_image: String,
    small_image: String,
    paused: bool,
    pos: f64,
    duration: f64,
    started_at: i64,
    sig: String,
}

struct DiscordInner {
    enabled: bool,
    client_id: String,
    large_image_key: String,
    small_image_key: String,
    status: String,
    active_track_id: Option<String>,
    started_at: Option<i64>,
    desired: Option<DesiredActivity>,
    last_requested: Option<String>,
    revision: u64,
}

impl DiscordInner {
    fn settings(&self) -> DiscordSettings {
        DiscordSettings {
            enabled: self.enabled,
            client_id: self.client_id.clone(),
            large_image_key: self.large_image_key.clone(),
            small_image_key: self.small_image_key.clone(),
            status: self.status.clone(),
        }
    }
}

struct Shared {
    inner: Mutex<DiscordInner>,
    signal: Condvar,
}

pub struct DiscordRpc {
    shared: Arc<Shared>,
}

impl DiscordRpc {
    pub fn new(prefs: &Prefs, app: AppHandle) -> Self {
        // Discord requires Rich Presence to be tied to a registered
        // application. The user creates one at the Developer Portal and
        // pastes its application ID into Settings.
        let client_id = prefs.discord_client_id.trim().to_string();
        let enabled = prefs.discord_rpc_enabled;
        let shared = Arc::new(Shared {
            inner: Mutex::new(DiscordInner {
                enabled,
                client_id,
                large_image_key: prefs.discord_large_image_key.clone(),
                small_image_key: prefs.discord_small_image_key.clone(),
                status: if enabled {
                    "Connecting…".to_string()
                } else {
                    "Disabled".to_string()
                },
                active_track_id: None,
                started_at: None,
                desired: None,
                last_requested: None,
                revision: 0,
            }),
            signal: Condvar::new(),
        });

        let worker = Arc::clone(&shared);
        let _ = std::thread::Builder::new()
            .name("esm-discord".into())
            .spawn(move || run_worker(worker, app));

        Self { shared }
    }

    fn inner(&self) -> MutexGuard<'_, DiscordInner> {
        self.shared.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn settings(&self) -> DiscordSettings {
        self.inner().settings()
    }

    /// Toggle Rich Presence without touching the stored configuration:
    /// the application ID and asset keys are fixed for this build.
    pub fn set_enabled(&self, enabled: bool) -> DiscordSettings {
        let settings;
        {
            let mut inner = self.inner();
            inner.enabled = enabled;
            inner.desired = None;
            inner.active_track_id = None;
            inner.started_at = None;
            inner.last_requested = None;
            inner.status = if enabled {
                "Connecting…".to_string()
            } else {
                "Disabled".to_string()
            };
            inner.revision = inner.revision.wrapping_add(1);
            settings = inner.settings();
        }
        self.shared.signal.notify_all();
        settings
    }

    /// Point Rich Presence at a different Discord application. The worker
    /// thread reconnects; the UI thread only updates the snapshot.
    pub fn set_client_id(&self, client_id: &str) -> DiscordSettings {
        let client_id = client_id.trim().to_string();
        let settings;
        {
            let mut inner = self.inner();
            if inner.client_id == client_id {
                return inner.settings();
            }
            inner.client_id = client_id;
            inner.desired = None;
            inner.active_track_id = None;
            inner.started_at = None;
            inner.last_requested = None;
            inner.status = if inner.enabled {
                "Connecting…".to_string()
            } else {
                "Disabled".to_string()
            };
            inner.revision = inner.revision.wrapping_add(1);
            settings = inner.settings();
        }
        self.shared.signal.notify_all();
        settings
    }

    /// Publish the current playback state. This never performs IPC itself:
    /// it only updates the shared snapshot and wakes the RPC thread.
    pub fn sync(
        &self,
        track: Option<PlayingTrack>,
        paused: bool,
        large_image: &str,
        pos: f64,
        duration: f64,
    ) -> DiscordSettings {
        let settings;
        let wake;
        {
            let mut inner = self.inner();

            if !inner.enabled {
                let changed = inner.desired.take().is_some() || inner.status != "Disabled";
                inner.active_track_id = None;
                inner.started_at = None;
                inner.last_requested = None;
                if changed {
                    inner.status = "Disabled".to_string();
                    inner.revision = inner.revision.wrapping_add(1);
                }
                settings = inner.settings();
                wake = changed;
            } else if inner.client_id.trim().is_empty() {
                let changed = inner.desired.take().is_some()
                    || inner.status != "Add a Discord application ID to connect";
                inner.status = "Add a Discord application ID to connect".to_string();
                if changed {
                    inner.revision = inner.revision.wrapping_add(1);
                }
                settings = inner.settings();
                wake = changed;
            } else if let Some(track) = track {
                let (_, pct) = progress_bar(pos, duration);
                if inner.active_track_id.as_deref() != Some(track.video_id.as_str()) {
                    inner.active_track_id = Some(track.video_id.clone());
                    inner.started_at = Some(now_secs());
                }
                let started_at = inner.started_at.unwrap_or_else(now_secs);
                let sig = format!("{}|{}|{}", track.video_id, paused as u8, pct / 5);

                if inner.last_requested.as_deref() == Some(sig.as_str()) {
                    settings = inner.settings();
                    wake = false;
                } else {
                    inner.last_requested = Some(sig.clone());
                    inner.desired = Some(DesiredActivity {
                        title: track.title.clone(),
                        artist: track.artist.clone(),
                        album: track.album.clone(),
                        large_image: large_image.to_string(),
                        small_image: inner.small_image_key.clone(),
                        paused,
                        pos,
                        duration,
                        started_at,
                        sig,
                    });
                    inner.revision = inner.revision.wrapping_add(1);
                    settings = inner.settings();
                    wake = true;
                }
            } else {
                let changed = inner.desired.take().is_some();
                inner.active_track_id = None;
                inner.started_at = None;
                inner.last_requested = None;
                let status_changed = inner.status != "Nothing playing";
                if changed || status_changed {
                    inner.status = "Nothing playing".to_string();
                    inner.revision = inner.revision.wrapping_add(1);
                }
                settings = inner.settings();
                wake = changed || status_changed;
            }
        }
        if wake {
            self.shared.signal.notify_all();
        }
        settings
    }
}

/// Owns the Discord IPC client. Every blocking call (connect, set_activity,
/// clear, close) happens here, never on the UI or command thread.
fn run_worker(shared: Arc<Shared>, app: AppHandle) {
    let mut client: Option<DiscordIpcClient> = None;
    let mut connected_to = String::new();
    let mut last_sig: Option<String> = None;
    let mut last_connect_attempt: Option<Instant> = None;

    loop {
        let (revision, enabled, client_id, desired) = {
            let inner = lock(&shared);
            (
                inner.revision,
                inner.enabled,
                inner.client_id.clone(),
                inner.desired.clone(),
            )
        };

        if !enabled {
            disconnect(&mut client);
            last_sig = None;
            last_connect_attempt = None;
            update_status(&shared, &app, "Disabled");
            wait_for_revision(&shared, revision, None);
            continue;
        }

        if client_id.trim().is_empty() {
            update_status(&shared, &app, "Add a Discord application ID to connect");
            wait_for_revision(&shared, revision, Some(IDLE_WAIT));
            continue;
        }

        // A changed application ID needs a fresh IPC connection.
        if client.is_some() && connected_to != client_id {
            disconnect(&mut client);
            last_sig = None;
            last_connect_attempt = None;
        }

        let Some(desired) = desired else {
            if client.is_some() && last_sig.is_some() {
                if let Some(ipc) = client.as_mut() {
                    let _ = ipc.clear_activity();
                }
                last_sig = None;
            }
            update_status(&shared, &app, "Nothing playing");
            wait_for_revision(&shared, revision, Some(IDLE_WAIT));
            continue;
        };

        // The activity is already on Discord: wait for the next state change.
        // The periodic refresh catches Discord being closed underneath us.
        if client.is_some() && last_sig.as_deref() == Some(desired.sig.as_str()) {
            let next = wait_for_revision(&shared, revision, Some(REFRESH_INTERVAL));
            if next == revision {
                last_sig = None;
            }
            continue;
        }

        if client.is_none() {
            if let Some(last) = last_connect_attempt {
                let elapsed = last.elapsed();
                if elapsed < RECONNECT_BACKOFF {
                    wait_for_revision(&shared, revision, Some(RECONNECT_BACKOFF - elapsed));
                    continue;
                }
            }
            last_connect_attempt = Some(Instant::now());
            update_status(&shared, &app, "Connecting…");

            let mut candidate = DiscordIpcClient::new(&client_id);
            match candidate.connect() {
                Ok(()) => {
                    client = Some(candidate);
                    connected_to = client_id.clone();
                }
                Err(e) => {
                    let error_msg = format!("Discord is not available: {e}");
                    eprintln!("{}", error_msg);
                    eprintln!("Troubleshooting:");
                    eprintln!("  1. Make sure Discord desktop app is running");
                    eprintln!("  2. Check your Discord Application ID in settings");
                    eprintln!("  3. Restart Discord and try again");
                    update_status(&shared, &app, &error_msg);
                    wait_for_revision(&shared, revision, Some(IDLE_WAIT));
                    continue;
                }
            }
        }

        match client.as_mut() {
            Some(ipc) => match publish(ipc, &desired) {
                Ok(()) => {
                    last_sig = Some(desired.sig.clone());
                    update_status(
                        &shared,
                        &app,
                        if desired.paused {
                            "Paused"
                        } else {
                            "Connected"
                        },
                    );
                }
                Err(e) => {
                    let error_msg = format!("Could not update Discord: {e}");
                    eprintln!("{}", error_msg);
                    eprintln!("Hint: Make sure Discord desktop app is running");
                    update_status(&shared, &app, &error_msg);
                    disconnect(&mut client);
                    last_sig = None;
                    last_connect_attempt = Some(Instant::now());
                }
            },
            None => {
                // The connection should have been established above; retry.
                last_connect_attempt = Some(Instant::now());
            }
        }
    }
}

fn lock(shared: &Shared) -> MutexGuard<'_, DiscordInner> {
    shared.inner.lock().unwrap_or_else(|e| e.into_inner())
}

fn update_status(shared: &Shared, app: &AppHandle, status: &str) {
    let settings = {
        let mut inner = lock(shared);
        if inner.status == status {
            return;
        }
        inner.status = status.to_string();
        inner.settings()
    };
    let _ = app.emit(DISCORD_STATUS_EVENT, settings);
}

/// Wait until the shared revision changes, or until the timeout expires.
/// Returns the revision observed on exit.
fn wait_for_revision(shared: &Shared, seen: u64, timeout: Option<Duration>) -> u64 {
    let mut inner = lock(shared);
    if inner.revision != seen {
        return inner.revision;
    }

    match timeout {
        None => {
            while inner.revision == seen {
                inner = shared.signal.wait(inner).unwrap_or_else(|e| e.into_inner());
            }
            inner.revision
        }
        Some(duration) => {
            let deadline = Instant::now() + duration;
            loop {
                let now = Instant::now();
                if now >= deadline {
                    return inner.revision;
                }
                let (guard, _) = shared
                    .signal
                    .wait_timeout(inner, deadline - now)
                    .unwrap_or_else(|e| e.into_inner());
                inner = guard;
                if inner.revision != seen {
                    return inner.revision;
                }
            }
        }
    }
}

fn disconnect(client: &mut Option<DiscordIpcClient>) {
    if let Some(mut ipc) = client.take() {
        let _ = ipc.clear_activity();
        let _ = ipc.close();
    }
}

fn publish(ipc: &mut DiscordIpcClient, desired: &DesiredActivity) -> Result<(), String> {
    let (bar, pct) = progress_bar(desired.pos, desired.duration);
    let title = truncate(&desired.title, 128);
    let artist = if desired.artist.trim().is_empty() {
        "Esmeringhoy".to_string()
    } else {
        truncate(desired.artist.trim(), 128)
    };
    let state = if desired.paused {
        format!("Paused · {artist} · {bar} {pct}%")
    } else {
        format!("{artist} · {bar} {pct}%")
    };
    let large_text = if !desired.album.trim().is_empty() {
        truncate(desired.album.trim(), 128)
    } else if artist == "Esmeringhoy" {
        "Esmeringhoy".to_string()
    } else {
        artist.clone()
    };

    let assets = Assets::new()
        .large_image(desired.large_image.as_str())
        .large_text(large_text.as_str())
        .small_image(desired.small_image.as_str())
        .small_text(artist.as_str());

    let mut activity = Activity::new()
        .name("Esmeringhoy")
        .state(truncate(&state, 128))
        .details(title)
        .assets(assets);
    if desired.paused {
        activity = activity.timestamps(Timestamps::new().start(desired.started_at));
    } else if desired.duration > 0.0 {
        let duration = desired.duration.round().max(1.0) as i64;
        activity = activity.timestamps(
            Timestamps::new()
                .start(desired.started_at)
                .end(desired.started_at + duration),
        );
    }

    ipc.set_activity(activity).map_err(|e| e.to_string())
}

fn progress_bar(pos: f64, duration: f64) -> (String, u8) {
    if !duration.is_finite() || duration <= 0.0 || !pos.is_finite() {
        return ("░░░░░░░░░░".to_string(), 0);
    }
    let pct = ((pos / duration) * 100.0).clamp(0.0, 100.0) as u8;
    let filled = ((pct as usize) + 5) / 10;
    let mut bar = String::with_capacity(30);
    for i in 0..10 {
        bar.push_str(if i < filled { "▓" } else { "░" });
    }
    (bar, pct)
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn truncate(value: &str, max_bytes: usize) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        if out.len() + ch.len_utf8() > max_bytes {
            break;
        }
        out.push(ch);
    }
    out
}
