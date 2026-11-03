//! Tauri commands — the only surface between the webview and the world.
//! Everything network-shaped goes through `api_call` (or a typed helper);
//! the webview never sees the session token.

use crate::engine::PlayingTrack;
use crate::keystore;
use crate::state::AppState;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, State};

/// Generic API passthrough. Always answers (even offline) with an envelope:
/// { status, ok, data } — status 0 means "network unreachable".
#[tauri::command]
pub async fn api_call(
    state: State<'_, Arc<AppState>>,
    method: String,
    path: String,
    body: Option<Value>,
) -> Result<Value, String> {
    match state.api.call(&method, &path, body).await {
        Ok(r) => Ok(json!({ "status": r.status, "ok": r.ok(), "data": r.json })),
        Err(e) => Ok(json!({ "status": 0, "ok": false, "data": { "error": format!("Network unreachable: {e}") } })),
    }
}

/// Password sign-in. The backend answers with a session token when asked;
/// we keep it in the OS credential manager and in memory only.
#[tauri::command]
pub async fn auth_sign_in(
    state: State<'_, Arc<AppState>>,
    username: String,
    password: String,
) -> Result<Value, String> {
    let username = username.trim().to_string();
    if username.is_empty() || password.is_empty() {
        return Err("Enter a username and password.".into());
    }
    let r = state
        .api
        .call(
            "POST",
            "/api/auth/login",
            Some(json!({ "username": username, "password": password, "token": true })),
        )
        .await
        .map_err(|e| e.to_string())?;

    if !r.ok() {
        let msg = r
            .json
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Wrong username or password.");
        return Err(msg.to_string());
    }

    let token = r
        .json
        .get("token")
        .and_then(Value::as_str)
        .ok_or_else(|| "the server did not return a session token — update the backend (M0.5 gate fix)".to_string())?;
    keystore::save_token(token).map_err(|e| format!("could not store the session securely: {e}"))?;
    state.api.set_token(Some(token.to_string()));

    Ok(json!({ "user": r.json.get("user").cloned().unwrap_or(Value::Null) }))
}

/// Registration (password only on desktop). Stores the session token like
/// sign-in.
#[tauri::command]
pub async fn auth_register(
    state: State<'_, Arc<AppState>>,
    username: String,
    password: String,
    email: Option<String>,
    invite: Option<String>,
) -> Result<Value, String> {
    let username = username.trim().to_string();
    if username.is_empty() || password.is_empty() {
        return Err("Enter a username and password.".into());
    }
    let mut body = json!({ "username": username, "password": password, "token": true });
    if let Some(e) = email.filter(|e| !e.trim().is_empty()) {
        body["email"] = json!(e.trim());
    }
    if let Some(i) = invite.filter(|i| !i.trim().is_empty()) {
        body["invite"] = json!(i.trim());
    }

    let r = state
        .api
        .call("POST", "/api/auth/register", Some(body))
        .await
        .map_err(|e| e.to_string())?;

    if !r.ok() {
        let msg = r
            .json
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Could not create the account.");
        return Err(msg.to_string());
    }

    let token = r
        .json
        .get("token")
        .and_then(Value::as_str)
        .ok_or_else(|| "the server did not return a session token — update the backend".to_string())?;
    keystore::save_token(token).map_err(|e| format!("could not store the session securely: {e}"))?;
    state.api.set_token(Some(token.to_string()));

    Ok(json!({ "user": r.json.get("user").cloned().unwrap_or(Value::Null) }))
}

/// Silent relaunch: reuse the stored token; drop it if the server says no.
#[tauri::command]
pub async fn auth_restore(state: State<'_, Arc<AppState>>) -> Result<Value, String> {
    let Some(token) = keystore::load_token() else {
        return Ok(json!({ "signedIn": false }));
    };
    state.api.set_token(Some(token));
    Ok(match state.api.get("/api/auth/me").await {
        Ok(r) if r.ok() => json!({ "signedIn": true, "user": r.json.get("user").cloned() }),
        Ok(_) => {
            let _ = keystore::delete_token();
            state.api.set_token(None);
            json!({ "signedIn": false })
        }
        Err(_) => json!({ "signedIn": true, "offline": true, "user": Value::Null }),
    })
}

/// Sign out: revoke the server session, stop audio, clear the stored token.
#[tauri::command]
pub async fn auth_sign_out(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let _ = state.api.call("POST", "/api/auth/logout", Some(json!({}))).await;
    state.engine.stop();
    state.api.set_token(None);
    keystore::delete_token()
}

/// Load a track (already cleared by the server) and play it.
#[tauri::command]
pub async fn engine_load(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    track: Value,
) -> Result<(), String> {
    let t = PlayingTrack::from_snapshot_current(&track).ok_or("bad track object")?;
    let api = Arc::clone(&state.api);
    let cache = Arc::clone(&state.cache);
    state.engine
        .load_and_play(&app, &api, &cache, t)
        .await
        .map_err(|e| e.to_string())
}

/// Pause/resume the current track. Returns the new paused state, or null if
/// there is nothing to toggle.
#[tauri::command]
pub fn engine_toggle(state: State<'_, Arc<AppState>>) -> Value {
    match state.engine.toggle_pause() {
        Some(paused) => json!({ "paused": paused }),
        None => json!({ "paused": Value::Null }),
    }
}

#[tauri::command]
pub fn engine_seek(state: State<'_, Arc<AppState>>, secs: f64) -> Result<(), String> {
    state.engine.seek(secs).map_err(|e| e.to_string())
}

/// Follow the server's transport state (the snapshot is the source of
/// truth for playing/paused; the engine follows it).
#[tauri::command]
pub fn engine_set_transport(state: State<'_, Arc<AppState>>, transport: String) {
    let should_pause = transport == "paused" || transport == "idle";
    if let Some(currently_paused) = {
        let player = state.engine.state();
        match player.state {
            "playing" | "paused" => Some(player.state == "paused"),
            _ => None,
        }
    } {
        if currently_paused != should_pause {
            state.engine.toggle_pause();
        }
    }
}

/// Stop playback entirely (no track loaded).
#[tauri::command]
pub fn engine_stop(state: State<'_, Arc<AppState>>) {
    state.engine.stop();
}

#[tauri::command]
pub fn engine_set_volume(state: State<'_, Arc<AppState>>, volume: f32) -> Result<f32, String> {
    let v = volume.clamp(0.0, 1.0);
    state.engine.set_volume(v);
    if let Ok(mut prefs) = state.prefs.lock() {
        prefs.volume = v;
    }
    state.save_prefs().map_err(|e| e.to_string())?;
    Ok(v)
}

#[tauri::command]
pub fn engine_state(state: State<'_, Arc<AppState>>) -> Value {
    let mut s = state.engine.state();
    // (kept for API stability; the view already carries everything the UI needs)
    let _ = &mut s;
    json!({
        "state": s.state,
        "pos": s.pos,
        "duration": s.duration,
        "volume": s.volume,
        "track": s.track,
        "cacheBytes": state.cache.total_bytes(),
    })
}

/// Wipe the track cache; returns bytes freed.
#[tauri::command]
pub fn cache_clear(state: State<'_, Arc<AppState>>) -> Result<u64, String> {
    state.engine.stop();
    state.cache.clear_all().map_err(|e| e.to_string())
}

/// App/backend health for the settings view.
#[tauri::command]
pub fn app_health(state: State<'_, Arc<AppState>>) -> Value {
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "api": state.api.base_url(),
        "signedIn": state.api.token().is_some(),
        "cacheBytes": state.cache.total_bytes(),
    })
}

/// The backend base URL — the webview needs it for media (`<img>`,
/// `<video>`) which cannot carry an Authorization header, so signed URLs
/// and artwork are addressed absolutely.
#[tauri::command]
pub fn api_base(state: State<'_, Arc<AppState>>) -> String {
    state.api.base_url().to_string()
}

/// Webview diagnostics: the ported UI writes errors here, so failures are
/// visible outside devtools (append-only, capped).
#[tauri::command]
pub fn web_log(state: State<'_, Arc<AppState>>, message: String) {
    let path = state.prefs_path.with_file_name("web.log");
    if let Ok(mut s) = std::fs::read_to_string(&path) {
        if s.len() > 256 * 1024 {
            s = s.chars().rev().take(128 * 1024).collect::<String>().chars().rev().collect();
        }
        s.push('\n');
        s.push_str(&message);
        let _ = std::fs::write(&path, s);
    } else {
        let _ = std::fs::write(&path, &message);
    }
}
