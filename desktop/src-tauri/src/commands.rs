use crate::api::ApiClient;
use crate::cache::TrackCache;
use crate::engine::PlayingTrack;
use crate::keystore;
use crate::state::AppState;
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::sync::Arc;
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

fn settings_json(state: &AppState) -> Value {
    let prefs = state.prefs.lock().unwrap().clone();
    json!({
        "autoUpdateCheck": prefs.auto_update_check,
        "ambientArtwork": prefs.ambient_artwork,
        "reduceMotion": prefs.reduce_motion,
        "discord": state.discord.settings(),
    })
}

fn sync_discord(state: &AppState) {
    let track = state.engine.current();
    let view = state.engine.state();
    let paused = view.state == "paused";
    let large_key = {
        let prefs = state.prefs.lock().unwrap();
        prefs.discord_large_image_key.clone()
    };
    // Discord accepts an HTTPS image URL anywhere an asset key is accepted,
    // so the large image switches to the current track's own artwork.
    let large_image = track
        .as_ref()
        .map(|t| t.thumb.clone())
        .filter(|u| !u.is_empty())
        .unwrap_or(large_key);
    state.discord.sync(track, paused, &large_image, view.pos, view.duration);
}

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
    sync_discord(&state);
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
    // The engine's own ended-handler and the UI poll can both ask for the
    // same next track. If we are already playing (or loading) it, a second
    // load would replay its intro — skip the duplicate.
    {
        let cur = state.engine.state();
        if cur.track.as_ref().is_some_and(|ct| ct.video_id == t.video_id)
            && (cur.state == "playing" || cur.state == "loading")
            && cur.pos < cur.duration.max(0.0) - 0.5
        {
            return Ok(());
        }
    }
    let api = Arc::clone(&state.api);
    let cache = Arc::clone(&state.cache);
    let result = state
        .engine
        .load_and_play(&app, &api, &cache, t)
        .await;
    sync_discord(&state);
    result.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn engine_toggle(state: State<'_, Arc<AppState>>) -> Value {
    let result = match state.engine.toggle_pause() {
        Some(paused) => Some(json!({ "paused": paused })),
        None => Some(json!({ "paused": Value::Null })),
    };
    sync_discord(&state);
    result.unwrap_or_else(|| json!({ "paused": Value::Null }))
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
pub async fn engine_set_transport(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    transport: String,
) -> Result<(), String> {
    let should_pause = transport == "paused" || transport == "idle";
    let current = state.engine.state();
    let currently_paused = match current.state {
        "playing" | "paused" => Some(current.state == "paused"),
        _ => None,
    };

    let Some(currently_paused) = currently_paused else {
        sync_discord(&state);
        return Ok(());
    };

    if currently_paused != should_pause {
        if should_pause {
            state.engine.toggle_pause();
            sync_discord(&state);
            return Ok(());
        }

        if !state.engine.is_player_empty() {
            state.engine.toggle_pause();
            sync_discord(&state);
            return Ok(());
        }

        let Some(track) = state.engine.current() else {
            sync_discord(&state);
            return Ok(());
        };
        let resume_at = current.pos;
        let api = Arc::clone(&state.api);
        let cache = Arc::clone(&state.cache);
        state.engine.stop();
        match state.engine.load_and_play(&app, &api, &cache, track).await {
            Ok(()) => {
                if resume_at > 0.25 {
                    let _ = state.engine.seek(resume_at);
                }
            }
            Err(e) => {
                let _ = app.emit(
                    crate::engine::player::ERROR_EVENT,
                    json!({ "message": e.to_string() }),
                );
            }
        }
    }
    sync_discord(&state);
    Ok(())
}

#[tauri::command]
pub fn engine_stop(state: State<'_, Arc<AppState>>) {
    state.engine.stop();
    sync_discord(&state);
}

#[tauri::command]
pub fn settings_get(state: State<'_, Arc<AppState>>) -> Value {
    settings_json(&state)
}

#[tauri::command]
pub fn general_set(
    state: State<'_, Arc<AppState>>,
    auto_update_check: bool,
) -> Result<Value, String> {
    {
        let mut prefs = state.prefs.lock().unwrap();
        prefs.auto_update_check = auto_update_check;
    }
    state.save_prefs().map_err(|e| e.to_string())?;
    Ok(settings_json(&state))
}

#[tauri::command]
pub fn appearance_set(
    state: State<'_, Arc<AppState>>,
    ambient_artwork: bool,
    reduce_motion: bool,
) -> Result<Value, String> {
    {
        let mut prefs = state.prefs.lock().unwrap();
        prefs.ambient_artwork = ambient_artwork;
        prefs.reduce_motion = reduce_motion;
    }
    state.save_prefs().map_err(|e| e.to_string())?;
    Ok(settings_json(&state))
}

#[tauri::command]
pub fn discord_rpc_set(
    state: State<'_, Arc<AppState>>,
    enabled: bool,
) -> Result<Value, String> {
    state.discord.set_enabled(enabled);
    {
        let mut prefs = state.prefs.lock().unwrap();
        prefs.discord_rpc_enabled = enabled;
    }
    state.save_prefs().map_err(|e| e.to_string())?;
    sync_discord(&state);
    Ok(settings_json(&state))
}

#[tauri::command]
pub fn discord_rpc_sync(state: State<'_, Arc<AppState>>) -> Value {
    sync_discord(&state);
    settings_json(&state)
}

#[tauri::command]
pub fn engine_set_volume(state: State<'_, Arc<AppState>>, volume: f32) -> Result<f32, String> {
    let v = volume.clamp(0.0, 1.0);
    state.engine.set_volume(v);
    {
        let mut prefs = state.prefs.lock().unwrap();
        // The UI polls and pushes the same volume ~once per 1.5s; only touch
        // the disk when the stored value actually changed.
        if (prefs.volume - v).abs() > 0.005 {
            prefs.volume = v;
            drop(prefs);
            state.save_prefs().map_err(|e| e.to_string())?;
        }
    }
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

#[tauri::command]
pub fn cached_tracks(state: State<'_, Arc<AppState>>, ids: Vec<String>) -> Vec<String> {
    ids.into_iter()
        .filter(|id| state.cache.is_cached(id, "m4a"))
        .collect()
}

#[tauri::command]
pub async fn cache_download_all(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    tracks: Vec<Value>,
) -> Result<(), String> {
    let parsed: Vec<PlayingTrack> = tracks
        .iter()
        .filter_map(|v| PlayingTrack::from_snapshot_current(v))
        .take(300)
        .collect();
    if parsed.is_empty() {
        return Err("no tracks to download".into());
    }
    let api = Arc::clone(&state.api);
    let cache = Arc::clone(&state.cache);
    let semaphore = Arc::new(tokio::sync::Semaphore::new(2));
    let mut handles = Vec::new();
    for track in parsed {
        let api = Arc::clone(&api);
        let cache = Arc::clone(&cache);
        let semaphore = Arc::clone(&semaphore);
        let app = app.clone();
        handles.push(tauri::async_runtime::spawn(async move {
            let perm = semaphore.acquire().await;
            let _permit = match perm {
                Ok(p) => p,
                Err(_) => return,
            };
            download_one_track(&app, &api, &cache, &track).await;
        }));
    }
    for h in handles {
        let _ = h.await;
    }
    Ok(())
}

async fn download_one_track(
    app: &AppHandle,
    api: &ApiClient,
    cache: &Arc<TrackCache>,
    track: &PlayingTrack,
) {
    let id = track.video_id.clone();
    let emit = |status: &str| {
        let _ = app.emit(
            "cache:download",
            json!({ "videoId": id, "status": status }),
        );
    };
    if cache.is_cached(&id, "m4a") {
        emit("cached");
        return;
    }
    emit("downloading");
    let dest = cache.path_for(&id, "m4a");
    let result = match crate::youtube::resolve(&id).await {
        Ok(res) => api.download_ranged(&res.url, &dest, |_, _| {}, None).await,
        Err(_) => api
            .download_ranged(&format!("/api/stream/{id}?codec=aac"), &dest, |_, _| {}, None)
            .await,
    };
    match result {
        Ok(bytes) => {
            // Header check: never cache a non-M4A payload.
            let valid = std::fs::File::open(&dest)
                .ok()
                .and_then(|mut f| {
                    use std::io::Read;
                    let mut head = [0u8; 12];
                    f.read(&mut head).ok().map(|n| n >= 8 && head[4..8] == *b"ftyp")
                })
                .unwrap_or(false);
            if valid {
                cache.record(&id, "m4a", bytes);
                emit("done");
            } else {
                let _ = std::fs::remove_file(&dest);
                emit("failed");
            }
        }
        Err(_) => {
            let _ = tokio::fs::remove_file(dest.with_extension("part")).await;
            emit("failed");
        }
    }
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

const UPDATE_DOWNLOAD_PREFIX: &str =
    "https://github.com/yekigarcia79-arch/Esmeringhoy-Exe/releases/download/";
const UPDATE_EMIT_MS: u64 = 100;

fn is_update_url(url: &str) -> bool {
    fn path_segment(segment: &str) -> bool {
        !segment.is_empty()
            && segment != "." && segment != ".."
            && segment.chars().all(|c| {
                c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')
            })
    }

    if url.len() > 2048
        || !url.starts_with(UPDATE_DOWNLOAD_PREFIX)
        || url.contains(['?', '#', '"', '<', '>', ' '])
    {
        return false;
    }

    let path = &url[UPDATE_DOWNLOAD_PREFIX.len()..];
    let segments: Vec<&str> = path.split('/').collect();
    if segments.len() < 2 || segments.iter().any(|segment| !path_segment(segment)) {
        return false;
    }
    segments
        .last()
        .map(|asset| asset.to_ascii_lowercase().ends_with("-setup.exe"))
        .unwrap_or(false)
}

fn valid_update_path(path: &std::path::Path) -> bool {
    let s = path.as_os_str().to_string_lossy();
    !s.is_empty()
        && !s.contains(['%', '"', '\r', '\n'])
        && !s.contains("!")
}

fn emit_update_progress(app: &AppHandle, downloaded: u64, total: Option<u64>) {
    let percent = total
        .filter(|total| *total > 0)
        .map(|total| ((downloaded as f64 / total as f64) * 100.0).clamp(0.0, 100.0).floor());
    let _ = app.emit(
        "update:progress",
        json!({
            "downloaded": downloaded,
            "total": total,
            "percent": percent,
        }),
    );
}

async fn download_update(
    app: &AppHandle,
    url: &str,
    dest: &Path,
) -> Result<u64, String> {
    use tokio::io::AsyncWriteExt;

    let client = reqwest::Client::builder()
        .user_agent(concat!("Esmeringhoy-Desktop/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let res = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("update download failed: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("update download failed: HTTP {}", res.status()));
    }

    let total = res.content_length();
    emit_update_progress(app, 0, total);

    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| format!("could not create the update file: {e}"))?;
    let mut stream = res.bytes_stream();
    let mut downloaded = 0u64;
    let mut last_emit = std::time::Instant::now();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("update download stream broke: {e}"))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("could not write the update file: {e}"))?;
        downloaded += chunk.len() as u64;

        let at_total = total.is_some_and(|t| downloaded >= t);
        if last_emit.elapsed() >= Duration::from_millis(UPDATE_EMIT_MS) || at_total {
            emit_update_progress(app, downloaded, total);
            last_emit = std::time::Instant::now();
        }
    }

    file.flush().await.map_err(|e| format!("could not flush the update file: {e}"))?;
    file.sync_all().await.map_err(|e| format!("could not sync the update file: {e}"))?;
    emit_update_progress(app, downloaded, total);
    Ok(downloaded)
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
    if !is_update_url(&url) {
        return Err("unexpected update source".into());
    }

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let setup = std::env::temp_dir().join(format!(
        "Esmeringhoy-update-{}-{stamp}.exe",
        std::process::id()
    ));
    let bat = std::env::temp_dir().join(format!(
        "esmeringhoy-update-{}-{stamp}.cmd",
        std::process::id()
    ));
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;

    if !valid_update_path(&setup) || !valid_update_path(&exe) || !valid_update_path(&bat) {
        return Err("the update path cannot be used by the installer script".into());
    }

    let downloaded = match download_update(&app, &url, &setup).await {
        Ok(downloaded) => downloaded,
        Err(e) => {
            let _ = tokio::fs::remove_file(&setup).await;
            return Err(e);
        }
    };

    if downloaded == 0 {
        let _ = tokio::fs::remove_file(&setup).await;
        return Err("the update download was empty".into());
    }

    let script = format!(
        "@echo off\r\nsetlocal\r\nset /a tries=0\r\n:wait\r\n\
         tasklist /FI \"IMAGENAME eq Esmeringhoy.exe\" /NH | find /I \"Esmeringhoy.exe\" >nul\r\n\
         if not errorlevel 1 (\r\n  set /a tries+=1\r\n\
           if %tries% geq 60 goto install\r\n\
           ping -n 2 127.0.0.1 >nul\r\n\
           goto wait\r\n\
         )\r\n\
         :install\r\n\
         \"{}\" /S\r\n\
         if errorlevel 0 start \"\" \"{}\"\r\n",
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
    let message: String = message.chars().take(2048).collect();
    let over_cap = std::fs::metadata(&path)
        .map(|m| m.len() > 256 * 1024)
        .unwrap_or(false);
    if over_cap {
        if let Ok(s) = std::fs::read_to_string(&path) {
            let trimmed: String = s.chars().rev().take(128 * 1024).collect::<String>().chars().rev().collect();
            let _ = std::fs::write(&path, trimmed);
        }
    }
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{message}");
    }
}

#[tauri::command]
pub fn cache_preload(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    tracks: Vec<Value>,
) -> Result<(), String> {
    let parsed: Vec<PlayingTrack> = tracks
        .iter()
        .filter_map(|v| PlayingTrack::from_snapshot_current(v))
        .collect();
    state.preloader.set_targets(app, parsed);
    Ok(())
}

#[tauri::command]
pub fn preload_status(state: State<'_, Arc<AppState>>) -> Value {
    json!(state.preloader.status_snapshot())
}
