use crate::commands;
use crate::engine::player::{PlayingTrack, ERROR_EVENT};
use crate::state::AppState;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent, Wry};

const TRAY_ID: &str = "esmeringhoy";
const MENU_PLAY_PAUSE: &str = "tray-play-pause";
const MENU_PREVIOUS: &str = "tray-previous";
const MENU_NEXT: &str = "tray-next";
const MENU_DISCORD: &str = "tray-discord";
const MENU_LYRICS: &str = "tray-lyrics";
const MENU_MUTE: &str = "tray-mute";
const MENU_OPEN: &str = "tray-open";
const MENU_SETTINGS: &str = "tray-settings";
const MENU_TERMS: &str = "tray-terms";
const MENU_QUIT: &str = "tray-quit";

const DEFAULT_VOLUME: f32 = 0.7;
// Windows closes a menu when its items are changed, so deferred updates are
// held off while the right-click menu is probably on screen.
const MENU_OPEN_GUARD: Duration = Duration::from_secs(30);

struct MenuHandles {
    play_pause: MenuItem<Wry>,
    mute: MenuItem<Wry>,
    discord: CheckMenuItem<Wry>,
}

pub struct TrayState {
    tray: Mutex<Option<TrayIcon<Wry>>>,
    handles: Mutex<Option<MenuHandles>>,
    signature: Mutex<String>,
    menu_open_until: Mutex<Option<Instant>>,
    previous_volume: Mutex<f32>,
    quitting: AtomicBool,
}

impl TrayState {
    fn new(signature: String, volume: f32) -> Self {
        Self {
            tray: Mutex::new(None),
            handles: Mutex::new(None),
            signature: Mutex::new(signature),
            menu_open_until: Mutex::new(None),
            previous_volume: Mutex::new(if volume > 0.001 { volume } else { DEFAULT_VOLUME }),
            quitting: AtomicBool::new(false),
        }
    }
}

pub fn init(app: &AppHandle) -> Result<(), String> {
    if app.try_state::<TrayState>().is_some() {
        return Ok(());
    }

    let state = app.state::<Arc<AppState>>().inner().clone();
    let signature = menu_signature(&state);
    let initial_volume = state.engine.volume();

    app.manage(TrayState::new(signature, initial_volume));

    let (menu, handles) = build_menu(app, &state).map_err(|e| e.to_string())?;
    let icon = app
        .default_window_icon()
        .cloned()
        .or_else(|| {
            tauri::image::Image::from_bytes(include_bytes!("../icons/128x128@2x.png")).ok()
        })
        .ok_or_else(|| "no application icon available for the tray".to_string())?;

    let tray = TrayIconBuilder::<Wry>::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("Esmeringhoy")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| handle_menu_event(app, &event))
        .on_tray_icon_event(|tray, event| {
            let app = tray.app_handle();
            match event {
                // Refresh the labels before the right-click menu is displayed.
                // Updating an open menu closes it, so this is the only safe moment.
                TrayIconEvent::Click {
                    button: MouseButton::Right,
                    button_state: MouseButtonState::Down,
                    ..
                } => {
                    if let Some(state) = app.try_state::<TrayState>() {
                        *state.menu_open_until.lock().unwrap() =
                            Some(Instant::now() + MENU_OPEN_GUARD);
                    }
                    sync_menu_force(app);
                }
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
                | TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                } => {
                    if let Some(state) = app.try_state::<TrayState>() {
                        *state.menu_open_until.lock().unwrap() = None;
                    }
                    show_main(app);
                }
                _ => {}
            }
        })
        .build(app)
        .map_err(|e| e.to_string())?;

    let tray_state = app.state::<TrayState>();
    *tray_state.handles.lock().unwrap() = Some(handles);
    *tray_state.tray.lock().unwrap() = Some(tray);
    Ok(())
}

pub fn install_close_handler(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let app = app.clone();
    window.on_window_event(move |event| {
        let WindowEvent::CloseRequested { api, .. } = event else {
            return;
        };
        let quitting = app
            .try_state::<TrayState>()
            .map(|state| state.quitting.load(Ordering::SeqCst))
            .unwrap_or(false);
        if quitting {
            return;
        }
        api.prevent_close();
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.hide();
        }
    });
}

fn menu_signature(state: &AppState) -> String {
    let view = state.engine.state();
    let playing = matches!(view.state, "playing" | "loading");
    let muted = view.volume <= 0.001;
    let discord = state.prefs.lock().unwrap().discord_rpc_enabled;
    format!("play={playing};mute={muted};discord={discord}")
}

pub fn sync_menu(app: &AppHandle) {
    sync_menu_inner(app, false);
}

fn sync_menu_force(app: &AppHandle) {
    sync_menu_inner(app, true);
}

fn sync_menu_inner(app: &AppHandle, force: bool) {
    let Some(state) = app.try_state::<Arc<AppState>>() else {
        return;
    };
    let Some(tray_state) = app.try_state::<TrayState>() else {
        return;
    };
    if !force {
        let mut until = tray_state.menu_open_until.lock().unwrap();
        match *until {
            Some(t) if Instant::now() < t => return,
            Some(_) => *until = None,
            None => {}
        }
    }
    let state = state.inner().clone();
    let view = state.engine.state();

    if view.volume > 0.001 {
        *tray_state.previous_volume.lock().unwrap() = view.volume;
    }

    let signature = menu_signature(&state);
    if *tray_state.signature.lock().unwrap() == signature {
        return;
    }

    let playing = matches!(view.state, "playing" | "loading");
    let muted = view.volume <= 0.001;
    let discord = state.prefs.lock().unwrap().discord_rpc_enabled;
    {
        let handles = tray_state.handles.lock().unwrap();
        let Some(handles) = handles.as_ref() else {
            return;
        };
        if let Err(e) = handles.play_pause.set_text(if playing { "Pause" } else { "Play" }) {
            eprintln!("[tray] could not update the play item: {e}");
        }
        if let Err(e) = handles.mute.set_text(if muted { "Unmute" } else { "Mute" }) {
            eprintln!("[tray] could not update the mute item: {e}");
        }
        if let Err(e) = handles.discord.set_checked(discord) {
            eprintln!("[tray] could not update the Discord item: {e}");
        }
    }
    *tray_state.signature.lock().unwrap() = signature;
}

fn build_menu(
    app: &AppHandle,
    state: &AppState,
) -> tauri::Result<(Menu<Wry>, MenuHandles)> {
    let view = state.engine.state();
    let playing = matches!(view.state, "playing" | "loading");
    let muted = view.volume <= 0.001;
    let discord = state.prefs.lock().unwrap().discord_rpc_enabled;

    let play_pause = MenuItem::with_id(
        app,
        MENU_PLAY_PAUSE,
        if playing { "Pause" } else { "Play" },
        true,
        None::<&str>,
    )?;
    let previous = MenuItem::with_id(app, MENU_PREVIOUS, "Previous Track", true, None::<&str>)?;
    let next = MenuItem::with_id(app, MENU_NEXT, "Next Track", true, None::<&str>)?;
    let discord = CheckMenuItem::with_id(
        app,
        MENU_DISCORD,
        "Discord RPC",
        true,
        discord,
        None::<&str>,
    )?;
    let lyrics = MenuItem::with_id(app, MENU_LYRICS, "Show Lyrics", true, None::<&str>)?;
    let mute = MenuItem::with_id(
        app,
        MENU_MUTE,
        if muted { "Unmute" } else { "Mute" },
        true,
        None::<&str>,
    )?;
    let open = MenuItem::with_id(app, MENU_OPEN, "Open Esmeringhoy", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, MENU_SETTINGS, "Settings", true, None::<&str>)?;
    let terms = MenuItem::with_id(
        app,
        MENU_TERMS,
        "Terms of Service",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "Quit Esmeringhoy", true, None::<&str>)?;

    let first_sep = PredefinedMenuItem::separator(app)?;
    let second_sep = PredefinedMenuItem::separator(app)?;
    let third_sep = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(
        app,
        &[
            &play_pause,
            &previous,
            &next,
            &first_sep,
            &discord,
            &lyrics,
            &mute,
            &second_sep,
            &open,
            &settings,
            &terms,
            &third_sep,
            &quit,
        ],
    )?;
    Ok((
        menu,
        MenuHandles {
            play_pause,
            mute,
            discord,
        },
    ))
}

pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn refresh_soon(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        sync_menu(&app);
    });
}

fn handle_menu_event(app: &AppHandle, event: &tauri::menu::MenuEvent) {
    if let Some(state) = app.try_state::<TrayState>() {
        *state.menu_open_until.lock().unwrap() = None;
    }
    if event.id() == MENU_PLAY_PAUSE {
        spawn_player_command(app, json!({ "cmd": "togglePlay" }));
    } else if event.id() == MENU_PREVIOUS {
        spawn_player_command(app, json!({ "cmd": "prev" }));
    } else if event.id() == MENU_NEXT {
        let body = app
            .try_state::<Arc<AppState>>()
            .map(|state| {
                let view = state.engine.state();
                json!({ "cmd": "next", "pos": view.pos, "dur": view.duration })
            })
            .unwrap_or_else(|| json!({ "cmd": "next" }));
        spawn_player_command(app, body);
    } else if event.id() == MENU_DISCORD {
        toggle_discord(app);
    } else if event.id() == MENU_LYRICS {
        show_main(app);
        let _ = app.emit("tray:lyrics", ());
    } else if event.id() == MENU_MUTE {
        toggle_mute(app);
    } else if event.id() == MENU_OPEN {
        show_main(app);
    } else if event.id() == MENU_SETTINGS {
        show_main(app);
        let _ = app.emit("tray:settings", ());
    } else if event.id() == MENU_TERMS {
        if let Err(e) = commands::open_https_url("https://esmeringhoy.pages.dev/terms") {
            eprintln!("[tray] could not open terms: {e}");
        }
    } else if event.id() == MENU_QUIT {
        quit(app);
    }
}

fn spawn_player_command(app: &AppHandle, body: Value) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = match app.try_state::<Arc<AppState>>() {
            Some(state) => state.inner().clone(),
            None => return,
        };
        if state.api.token().is_none() {
            show_main(&app);
            let _ = app.emit(ERROR_EVENT, json!({ "message": "Sign in to control playback." }));
            return;
        }
        if let Err(e) = apply_command(&app, &state, body).await {
            eprintln!("[tray] playback command failed: {e}");
            let _ = app.emit(ERROR_EVENT, json!({ "message": e }));
        }
        sync_menu(&app);
    });
}

async fn apply_command(app: &AppHandle, state: &Arc<AppState>, body: Value) -> Result<(), String> {
    let response = state
        .api
        .call("POST", "/api/cmd", Some(body))
        .await
        .map_err(|e| format!("network error: {e}"))?;
    if !response.ok() {
        return Err(format!("the server refused the tray command (HTTP {})", response.status));
    }

    let transport = response
        .json
        .get("transport")
        .and_then(Value::as_str)
        .unwrap_or("idle");
    let current = response
        .json
        .get("current")
        .and_then(PlayingTrack::from_snapshot_current);

    if let Some(track) = current {
        let same_track = state
            .engine
            .current()
            .is_some_and(|current| current.video_id == track.video_id);
        if !same_track || state.engine.is_player_empty() {
            state
                .engine
                .load_and_play(app, &state.api, &state.cache, track)
                .await
                .map_err(|e| format!("could not play that track: {e}"))?;
        }

        let engine_state = state.engine.state().state;
        let want_pause = transport == "paused" || transport == "idle";
        if want_pause && engine_state == "playing" {
            state.engine.toggle_pause();
        } else if !want_pause && engine_state == "paused" {
            state.engine.toggle_pause();
        }
    } else {
        state.engine.stop();
    }

    commands::sync_discord(state);
    Ok(())
}

fn toggle_mute(app: &AppHandle) {
    let Some(state) = app.try_state::<Arc<AppState>>() else {
        return;
    };
    let Some(tray_state) = app.try_state::<TrayState>() else {
        return;
    };
    let state = state.inner().clone();
    let current = state.engine.state().volume;
    let (target, pct) = if current > 0.001 {
        *tray_state.previous_volume.lock().unwrap() = current;
        (0.0, 0)
    } else {
        let previous = *tray_state.previous_volume.lock().unwrap();
        let target = if previous > 0.001 {
            previous
        } else {
            DEFAULT_VOLUME
        };
        (target, (target * 100.0).round() as u32)
    };

    state.engine.set_volume(target);
    let mut should_save = false;
    {
        let mut prefs = state.prefs.lock().unwrap();
        if (prefs.volume - target).abs() > 0.005 {
            prefs.volume = target;
            should_save = true;
        }
    }
    if should_save {
        let _ = state.save_prefs();
    }

    if state.api.token().is_some() {
        let api = Arc::clone(&state.api);
        tauri::async_runtime::spawn(async move {
            let _ = api
                .call("POST", "/api/cmd", Some(json!({ "cmd": "volume", "pct": pct })))
                .await;
        });
    }
    refresh_soon(app);
}

fn toggle_discord(app: &AppHandle) {
    let Some(state) = app.try_state::<Arc<AppState>>() else {
        return;
    };
    let state = state.inner().clone();
    let enabled = {
        let mut prefs = state.prefs.lock().unwrap();
        prefs.discord_rpc_enabled = !prefs.discord_rpc_enabled;
        prefs.discord_rpc_enabled
    };
    state.discord.set_enabled(enabled);
    let _ = state.save_prefs();
    commands::sync_discord(&state);
    refresh_soon(app);
}

pub fn quit(app: &AppHandle) {
    let Some(tray_state) = app.try_state::<TrayState>() else {
        app.exit(0);
        return;
    };
    if tray_state.quitting.swap(true, Ordering::SeqCst) {
        return;
    }

    if let Some(state) = app.try_state::<Arc<AppState>>() {
        state.engine.stop();
        state.discord.set_enabled(false);
    }

    let tray = tray_state.tray.lock().unwrap().take();
    if let Some(tray) = tray {
        let _ = tray.set_visible(false);
    }

    app.exit(0);
}
