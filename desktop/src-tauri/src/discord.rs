use crate::engine::PlayingTrack;
use crate::state::Prefs;
use discord_rich_presence::{
    activity::{Activity, Assets, Timestamps},
    DiscordIpc, DiscordIpcClient,
};
use serde::Serialize;
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

/// The Discord application Rich Presence connects through. Application IDs
/// are public (visible on the Discord Developer Portal) — they are not a
/// credential, so embedding one is safe.
pub const DEFAULT_CLIENT_ID: &str = "156819463189810562";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordSettings {
    pub enabled: bool,
    pub client_id: String,
    pub large_image_key: String,
    pub small_image_key: String,
    pub status: String,
}

struct DiscordInner {
    enabled: bool,
    client_id: String,
    large_image_key: String,
    small_image_key: String,
    status: String,
    client: Option<DiscordIpcClient>,
    active_track_id: Option<String>,
    started_at: Option<i64>,
    last_sig: Option<String>,
}

pub struct DiscordRpc {
    inner: Mutex<DiscordInner>,
}

impl DiscordRpc {
    pub fn new(prefs: &Prefs) -> Self {
        let client_id = match prefs.discord_client_id.trim() {
            "" => DEFAULT_CLIENT_ID.to_string(),
            id => id.to_string(),
        };
        Self {
            inner: Mutex::new(DiscordInner {
                enabled: prefs.discord_rpc_enabled,
                client_id,
                large_image_key: prefs.discord_large_image_key.clone(),
                small_image_key: prefs.discord_small_image_key.clone(),
                status: if prefs.discord_rpc_enabled {
                    "Not connected".to_string()
                } else {
                    "Disabled".to_string()
                },
                client: None,
                active_track_id: None,
                started_at: None,
                last_sig: None,
            }),
        }
    }

    pub fn settings(&self) -> DiscordSettings {
        let inner = self.inner();
        DiscordSettings {
            enabled: inner.enabled,
            client_id: inner.client_id.clone(),
            large_image_key: inner.large_image_key.clone(),
            small_image_key: inner.small_image_key.clone(),
            status: inner.status.clone(),
        }
    }

    /// Toggle Rich Presence without touching the stored configuration:
    /// the application ID and asset keys are fixed for this build.
    pub fn set_enabled(&self, enabled: bool) -> DiscordSettings {
        let mut inner = self.inner();
        disconnect(&mut inner, if enabled { "Connecting…" } else { "Disabled" });
        inner.enabled = enabled;
        inner.status = if enabled {
            "Not connected".to_string()
        } else {
            "Disabled".to_string()
        };
        settings_from(&inner)
    }

    pub fn sync(&self, track: Option<PlayingTrack>, paused: bool, large_image: &str, pos: f64, duration: f64) -> DiscordSettings {
        let mut inner = self.inner();
        if !inner.enabled {
            disconnect(&mut inner, "Disabled");
            return settings_from(&inner);
        }

        if inner.client_id.is_empty() {
            disconnect(&mut inner, "Add a Discord application ID to connect");
            return settings_from(&inner);
        }

        let Some(track) = track else {
            if inner.last_sig.as_deref() != Some("none") {
                if let Some(client) = inner.client.as_mut() {
                    let _ = client.clear_activity();
                }
                inner.last_sig = Some("none".to_string());
                inner.status = "Nothing playing".to_string();
            }
            return settings_from(&inner);
        };

        // Discord has no real seekbar, so the status line carries a text bar
        // built from the engine's actual position and duration (5% buckets —
        // keeps updates well under Discord's rate limit).
        let (bar, pct) = progress_bar(pos, duration);
        if inner.client.is_some()
            && inner.last_sig.as_deref()
                == Some(format!("{}|{}|{}", track.video_id, paused as u8, (pct / 5) as u8).as_str())
        {
            return settings_from(&inner);
        }

        if inner.active_track_id.as_deref() != Some(track.video_id.as_str()) {
            inner.active_track_id = Some(track.video_id.clone());
            inner.started_at = Some(now_secs());
        }

        if inner.client.is_none() {
            let mut client = DiscordIpcClient::new(&inner.client_id);
            if let Err(e) = client.connect() {
                inner.status = format!("Discord is not available: {e}");
                return settings_from(&inner);
            }
            inner.client = Some(client);
        }

        let started_at = inner.started_at.unwrap_or_else(now_secs);
        let title = truncate(&track.title, 128);
        let artist = if track.artist.trim().is_empty() {
            "Esmeringhoy".to_string()
        } else {
            truncate(track.artist.trim(), 128)
        };
        let state = if paused {
            format!("Paused · {artist} · {bar} {pct}%")
        } else {
            format!("{artist} · {bar} {pct}%")
        };
        let large_text = if !track.album.trim().is_empty() {
            truncate(track.album.trim(), 128)
        } else if artist == "Esmeringhoy" {
            "Esmeringhoy".to_string()
        } else {
            artist.clone()
        };

        let large_image_key = large_image.to_string();
        let small_image_key = inner.small_image_key.clone();
        let assets = Assets::new()
            .large_image(large_image_key.as_str())
            .large_text(large_text.as_str())
            .small_image(small_image_key.as_str())
            .small_text(artist.as_str());

        let mut activity =
            Activity::new().name("Esmeringhoy").state(truncate(&state, 128)).details(title).assets(assets);
        if paused {
            activity = activity.timestamps(Timestamps::new().start(started_at));
        } else if duration > 0.0 {
            let duration = duration.round().max(1.0) as i64;
            activity = activity.timestamps(
                Timestamps::new().start(started_at).end(started_at + duration),
            );
        }

        let sig = format!("{}|{}|{}", track.video_id, paused as u8, (pct / 5) as u8);
        let client = inner.client.as_mut().expect("client checked above");
        match client.set_activity(activity) {
            Ok(()) => {
                inner.status = if paused { "Paused".to_string() } else { "Connected".to_string() };
                inner.last_sig = Some(sig);
            }
            Err(e) => {
                inner.status = format!("Could not update Discord: {e}");
                inner.last_sig = None;
                if let Some(mut client) = inner.client.take() {
                    let _ = client.close();
                }
            }
        }

        settings_from(&inner)
    }

    fn inner(&self) -> MutexGuard<'_, DiscordInner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

fn progress_bar(pos: f64, duration: f64) -> (String, u8) {
    if !(duration > 0.0) || !pos.is_finite() {
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

fn settings_from(inner: &DiscordInner) -> DiscordSettings {
    DiscordSettings {
        enabled: inner.enabled,
        client_id: inner.client_id.clone(),
        large_image_key: inner.large_image_key.clone(),
        small_image_key: inner.small_image_key.clone(),
        status: inner.status.clone(),
    }
}

fn disconnect(inner: &mut DiscordInner, status: &str) {
    if let Some(mut client) = inner.client.take() {
        let _ = client.clear_activity();
        let _ = client.close();
    }
    inner.active_track_id = None;
    inner.started_at = None;
    inner.last_sig = None;
    inner.status = status.to_string();
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
