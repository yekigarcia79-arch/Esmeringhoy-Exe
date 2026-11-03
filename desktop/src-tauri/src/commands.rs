use crate::engine::PlayingTrack;
use crate::keystore;
use crate::state::AppState;
use serde_json::{json, Value};
use std::sync::Arc;
use std::os::windows::process::CommandExt;
use tauri::{AppHandle, State};

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

#[tauri::command]
pub async fn auth_sign_out(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let _ = state.api.call("POST", "/api/auth/logout", Some(json!({}))).await;
    state.engine.stop();
    state.api.set_token(None);
    keystore::delete_token()
}

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

#[tauri::command]
pub fn engine_toggle(state: State<'_, Arc<AppState>>) -> Value {
    match state.engine.toggle_pause() {
        Some(paused) => json!({ "paused": paused }),
        None => json!({ "paused": Value::Null }),
    }
}

#[tauri::command]
pub async fn engine_seek(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    secs: f64,
) -> Result<(), String> {
    if let Some(tail) = state.engine.streaming_tail() {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        while !tail.is_done() && std::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        if tail.error().is_none() {
            if let Some(track) = state.engine.current() {
                let api = Arc::clone(&state.api);
                let cache = Arc::clone(&state.cache);
                state.engine.stop();
                state
                    .engine
                    .load_and_play(&app, &api, &cache, track)
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    state.engine.seek(secs).map_err(|e| e.to_string())
}

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

#[tauri::command]
pub fn cache_clear(state: State<'_, Arc<AppState>>) -> Result<u64, String> {
    state.cache.clear_all().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn cache_stats(state: State<'_, Arc<AppState>>) -> Value {
    let (used, tracks) = state.cache.stats();
    json!({
        "usedBytes": used,
        "tracks": tracks,
        "limitBytes": state.cache.cap(),
    })
}

#[tauri::command]
pub fn cache_set_limit(state: State<'_, Arc<AppState>>, gb: u64) -> Result<Value, String> {
    state.set_cache_limit(gb).map_err(|e| e.to_string())?;
    let (used, tracks) = state.cache.stats();
    Ok(json!({
        "usedBytes": used,
        "tracks": tracks,
        "limitBytes": state.cache.cap(),
    }))
}

const UPDATE_REPO: &str = "yekigarcia79-arch/Esmeringhoy-Exe";

fn version_tuple(v: &str) -> [u64; 3] {
    let mut out = [0u64; 3];
    for (i, part) in v.trim_start_matches('v').split('.').take(3).enumerate() {
        out[i] = part.parse().unwrap_or(0);
    }
    out
}

fn is_newer(remote: &str, local: &str) -> bool {
    version_tuple(remote) > version_tuple(local)
}

fn can_self_update() -> bool {
    let exe = std::env::current_exe().unwrap_or_default();
    let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
    if local.is_empty() {
        return false;
    }
    let exe = exe.to_string_lossy().to_lowercase();
    let want = format!("{}\\esmeringhoy\\", local.to_lowercase());
    exe.starts_with(&want)
}

#[tauri::command]
pub async fn check_update() -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .user_agent("Esmeringhoy-Desktop")
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .get(format!("https://api.github.com/repos/{UPDATE_REPO}/releases/latest"))
        .header("accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if res.status() == 404 {
        return Ok(json!({ "available": false }));
    }
    if !res.status().is_success() {
        return Err(format!("GitHub answered HTTP {}", res.status()));
    }
    let body: Value = res.json().await.map_err(|e| e.to_string())?;
    let tag = body.get("tag_name").and_then(|v| v.as_str()).unwrap_or("");
    let url = body
        .get("assets")
        .and_then(|a| a.as_array())
        .and_then(|arr| {
            arr.iter().find(|a| {
                a.get("name")
                    .and_then(|n| n.as_str())
                    .map(|n| n.to_lowercase().ends_with("-setup.exe"))
                    .unwrap_or(false)
            })
        })
        .and_then(|a| a.get("browser_download_url"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    Ok(json!({
        "available": !url.is_empty() && is_newer(tag, env!("CARGO_PKG_VERSION")),
        "version": tag.trim_start_matches('v'),
        "notes": body.get("body").and_then(|v| v.as_str()).unwrap_or(""),
        "url": url,
        "canInstall": can_self_update(),
    }))
}

#[tauri::command]
pub async fn install_update(app: AppHandle, url: String) -> Result<(), String> {
    if !can_self_update() {
        return Err("this copy was not installed by the setup".into());
    }
    if !url.starts_with("https://github.com/") {
        return Err("unexpected update source".into());
    }
    let res = reqwest::get(&url).await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("download failed: HTTP {}", res.status()));
    }
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    let setup = std::env::temp_dir().join("Esmeringhoy-update-setup.exe");
    std::fs::write(&setup, &bytes).map_err(|e| e.to_string())?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let bat = std::env::temp_dir().join("esmeringhoy-update.cmd");
    let script = format!(
        "@echo off\r\n\"{}\" /S\r\nping -n 7 127.0.0.1 >nul\r\nstart \"\" \"{}\"\r\n",
        setup.display(),
        exe.display()
    );
    std::fs::write(&bat, script).map_err(|e| e.to_string())?;
    std::process::Command::new("cmd")
        .arg("/C")
        .arg(&bat)
        .creation_flags(0x08000000)
        .spawn()
        .map_err(|e| e.to_string())?;
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("only https links".into());
    }
    std::process::Command::new("cmd")
        .args(["/C", "start", "", &url])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn app_health(state: State<'_, Arc<AppState>>) -> Value {
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "api": state.api.base_url(),
        "signedIn": state.api.token().is_some(),
        "cacheBytes": state.cache.total_bytes(),
    })
}

#[tauri::command]
pub fn api_base(state: State<'_, Arc<AppState>>) -> String {
    state.api.base_url().to_string()
}

#[tauri::command]
pub async fn artist_thumb(
    state: State<'_, Arc<AppState>>,
    name: String,
) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("empty artist name".into());
    }
    state.api.thumb_data_url(name).await.map_err(|e| e.to_string())
}

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
