use crate::api::ApiClient;
use crate::cache::TrackCache;
use crate::engine::PlayingTrack;
use crate::keystore;
use crate::state::AppState;
use serde_json::{json, Value};
use std::fs::File;
use std::io::BufReader;
use std::sync::Arc;
use std::path::Path;
use tauri::{AppHandle, Emitter, State};
use rodio::Source;

fn settings_json(state: &AppState) -> Value {
    let prefs = state.prefs.lock().unwrap().clone();
    json!({
        "autoUpdateCheck": prefs.auto_update_check,
        "ambientArtwork": prefs.ambient_artwork,
        "reduceMotion": prefs.reduce_motion,
        "draggableWaveforms": prefs.draggable_waveforms,
        "discord": state.discord.settings(),
    })
}

pub(crate) fn sync_discord(state: &AppState) {
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
    terms: Option<bool>,
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
    // Recorded by the server as users.terms_accepted_at. Sent only when true,
    // so an older server that does not know the field sees no change at all.
    if terms.unwrap_or(false) {
        body["terms"] = json!(true);
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

    // Registration no longer signs anyone in. The account is created pending
    // and stays inert until the emailed link is opened, so there is no token
    // to store — that is a success, not a missing field.
    if r.json.get("pending").and_then(Value::as_bool).unwrap_or(false) {
        return Ok(json!({
            "pending": true,
            "email": r.json.get("email").cloned().unwrap_or(Value::Null),
            "message": r.json.get("message").cloned().unwrap_or(Value::Null),
            "warning": r.json.get("warning").cloned().unwrap_or(Value::Null),
        }));
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
pub async fn auth_email_start(
    state: State<'_, Arc<AppState>>,
    email: String,
) -> Result<Value, String> {
    let email = email.trim().to_string();
    if email.is_empty() {
        return Err("Enter your email address.".into());
    }
    let r = state
        .api
        .call(
            "POST",
            "/api/auth/email/start",
            Some(json!({ "email": email })),
        )
        .await
        .map_err(|e| e.to_string())?;

    if !r.ok() {
        let msg = r
            .json
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Could not send the code.");
        return Err(msg.to_string());
    }

    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn auth_email_verify(
    state: State<'_, Arc<AppState>>,
    email: String,
    code: String,
) -> Result<Value, String> {
    let email = email.trim().to_string();
    let code = code.trim().to_string();
    if email.is_empty() {
        return Err("Enter your email address.".into());
    }
    if code.len() != 6 {
        return Err("Enter the 6-digit code.".into());
    }
    let r = state
        .api
        .call(
            "POST",
            "/api/auth/email/verify",
            // `token: true` is what makes the server return a session token in
            // the body. Without it the response is valid but tokenless, and the
            // desktop has nothing to store.
            Some(json!({ "email": email, "code": code, "token": true })),
        )
        .await
        .map_err(|e| e.to_string())?;

    if !r.ok() {
        let msg = r
            .json
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("That code did not work.");
        return Err(msg.to_string());
    }

    let token = r
        .json
        .get("token")
        .and_then(Value::as_str)
        .ok_or_else(|| "the server did not return a session token — update the backend".to_string())?;
    keystore::save_token(token).map_err(|e| format!("could not store the session securely: {e}"))?;
    state.api.set_token(Some(token.to_string()));

    Ok(json!({
        "user": r.json.get("user").cloned().unwrap_or(Value::Null),
        "state": r.json.get("state").cloned().unwrap_or(Value::Null),
        "created": r.json.get("created").cloned().unwrap_or(Value::Null),
    }))
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
pub fn island_ready(island: State<'_, crate::island::IslandState>) {
    island.mark_ready();
}

#[tauri::command]
pub fn island_pin(island: State<'_, crate::island::IslandState>, pinned: bool) {
    island.set_pinned(pinned);
}

#[tauri::command]
pub async fn island_command(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    cmd: String,
) -> Result<(), String> {
    if state.api.token().is_none() {
        return Err("Sign in to control playback.".into());
    }
    let body = match cmd.as_str() {
        "prev" => json!({ "cmd": "prev" }),
        "next" => {
            let view = state.engine.state();
            json!({ "cmd": "next", "pos": view.pos, "dur": view.duration })
        }
        "togglePlay" => json!({ "cmd": "togglePlay" }),
        _ => return Err("unknown island command".into()),
    };
    crate::tray::apply_command(&app, state.inner(), body).await
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
pub fn waveforms_set(
    state: State<'_, Arc<AppState>>,
    enabled: bool,
) -> Result<Value, String> {
    {
        let mut prefs = state.prefs.lock().unwrap();
        prefs.draggable_waveforms = enabled;
    }
    state.save_prefs().map_err(|e| e.to_string())?;
    Ok(settings_json(&state))
}

fn valid_waveform_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 20
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn decode_waveform(path: &Path) -> Result<Vec<f32>, String> {
    let file = File::open(path).map_err(|e| format!("opening audio for waveform: {e}"))?;
    let decoder = rodio::Decoder::new(BufReader::new(file))
        .map_err(|e| format!("decoding audio for waveform: {e}"))?;

    let channels = decoder.channels().get() as usize;
    let rate = decoder.sample_rate().get() as usize;
    let target_buckets = 4096usize;
    let bucket = decoder
        .total_duration()
        .map(|d| {
            ((d.as_secs_f64() * rate as f64 * channels as f64) / target_buckets as f64)
                .ceil()
                .max(1.0) as usize
        })
        .unwrap_or(8192)
        .max(256);

    let mut peaks = Vec::with_capacity(target_buckets);
    let mut peak = 0.0f32;
    let mut count = 0usize;
    for sample in decoder {
        let amp = sample.abs();
        if amp.is_finite() && amp > peak {
            peak = amp;
        }
        count += 1;
        if count >= bucket {
            peaks.push(peak);
            peak = 0.0;
            count = 0;
        }
    }
    if count > 0 {
        peaks.push(peak);
    }
    if peaks.is_empty() {
        return Err("the track has no audio samples".into());
    }

    let max = peaks.iter().copied().fold(0.0f32, f32::max);
    if max > 0.0 {
        for value in &mut peaks {
            *value = (*value / max).clamp(0.0, 1.0);
        }
    }
    Ok(peaks)
}

#[tauri::command]
pub async fn waveform_peaks(
    state: State<'_, Arc<AppState>>,
    video_id: String,
) -> Result<Vec<f32>, String> {
    if !valid_waveform_id(&video_id) {
        return Err("invalid track id".into());
    }

    let cache = Arc::clone(&state.cache);
    if let Some(cached) = cache.lookup(&video_id, "m4a") {
        return tauri::async_runtime::spawn_blocking(move || decode_waveform(&cached))
            .await
            .map_err(|e| e.to_string())?;
    }

    let api = Arc::clone(&state.api);
    let temp = std::env::temp_dir().join(format!("esm-wave-{}-{video_id}.m4a", std::process::id()));
    let _ = std::fs::remove_file(&temp);

    let mut downloaded = false;
    if let Ok(resolved) = crate::youtube::resolve(&video_id).await {
        downloaded = api
            .download_ranged(&resolved.url, &temp, |_, _| {}, None)
            .await
            .is_ok();
    }
    if !downloaded {
        if let Err(e) = api
            .download_ranged(
                &format!("/api/stream/{video_id}?codec=aac"),
                &temp,
                |_, _| {},
                None,
            )
            .await
        {
            let _ = std::fs::remove_file(&temp);
            return Err(format!("downloading audio for waveform: {e}"));
        }
    }

    let path = temp.clone();
    let decoded = tauri::async_runtime::spawn_blocking(move || decode_waveform(&path)).await;
    let _ = std::fs::remove_file(&temp);
    decoded.map_err(|e| e.to_string())?
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

pub(crate) fn open_https_url(url: &str) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("only https links".into());
    }
    std::process::Command::new("cmd")
        .args(["/C", "start", "", url])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    open_https_url(&url)
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
