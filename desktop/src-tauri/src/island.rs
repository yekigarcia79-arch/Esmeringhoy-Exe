use crate::state::AppState;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize};

pub const ISLAND_LABEL: &str = "island";
pub const REVEAL_EVENT: &str = "island:reveal";
pub const HIDE_EVENT: &str = "island:hide";

const ISLAND_W: f64 = 424.0;
const ISLAND_H: f64 = 112.0;
const TOP_MARGIN: f64 = 12.0;
const POLL_MS: u64 = 80;
const HIDE_GRACE_MS: u64 = 320;
const HIDE_ANIM_MS: u64 = 190;
const PIN_TTL: Duration = Duration::from_secs(5);
const DISABLED_POLL_MS: u64 = 250;

pub struct IslandState {
    enabled: AtomicBool,
    shown: AtomicBool,
    ready: AtomicBool,
    quitting: AtomicBool,
    pinned_at: Mutex<Option<Instant>>,
}

impl IslandState {
    fn is_pinned(&self) -> bool {
        self.pinned_at
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|at| at.elapsed() < PIN_TTL)
    }

    pub fn mark_ready(&self) {
        self.ready.store(true, Ordering::SeqCst);
    }

    pub fn set_pinned(&self, pinned: bool) {
        *self.pinned_at.lock().unwrap() = if pinned { Some(Instant::now()) } else { None };
    }
}

pub fn init(app: &AppHandle) -> Result<(), String> {
    let enabled = app
        .state::<Arc<AppState>>()
        .prefs
        .lock()
        .unwrap()
        .dynamic_island_enabled;

    app.manage(IslandState {
        enabled: AtomicBool::new(enabled),
        shown: AtomicBool::new(false),
        ready: AtomicBool::new(false),
        quitting: AtomicBool::new(false),
        pinned_at: Mutex::new(None),
    });

    let window = app
        .get_webview_window(ISLAND_LABEL)
        .ok_or_else(|| "the island window is missing".to_string())?;
    let _ = window.set_focusable(false);
    let _ = window.hide();
    if let Some((x, y, w, h)) = island_rect(app) {
        let _ = window.set_size(PhysicalSize::new(w, h));
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }

    spawn_poller(app.clone());
    Ok(())
}

pub fn set_enabled(app: &AppHandle, enabled: bool) {
    let Some(state) = app.try_state::<IslandState>() else {
        return;
    };
    state.enabled.store(enabled, Ordering::SeqCst);
    state.set_pinned(false);
    if !enabled {
        state.shown.store(false, Ordering::SeqCst);
        hide_window(app);
    }
}

pub fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<IslandState>() {
        state.quitting.store(true, Ordering::SeqCst);
        state.shown.store(false, Ordering::SeqCst);
    }
    hide_window(app);
}

fn hide_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(ISLAND_LABEL) {
        let _ = window.hide();
    }
}

fn island_rect(app: &AppHandle) -> Option<(i32, i32, u32, u32)> {
    let monitor = app.primary_monitor().ok().flatten()?;
    let scale = if monitor.scale_factor() > 0.1 {
        monitor.scale_factor()
    } else {
        1.0
    };
    let screen = monitor.position();
    let size = monitor.size();
    let work = monitor.work_area();

    let w = (ISLAND_W * scale).round() as u32;
    let h = (ISLAND_H * scale).round() as u32;
    let x = screen.x + (size.width as i32 - w as i32) / 2;
    // Stay clear of a top-docked taskbar while still hugging the top edge.
    let top = if work.size.height > 0 && work.size.width > 0 {
        work.position.y
    } else {
        screen.y
    };
    let y = top + (TOP_MARGIN * scale).round() as i32;
    Some((x, y, w, h))
}

fn is_over_island(x: f64, y: f64, rx: i32, ry: i32, rw: u32, rh: u32) -> bool {
    x >= rx as f64
        && x < rx as f64 + rw as f64
        && y >= ry as f64
        && y < ry as f64 + rh as f64
}

fn spawn_poller(app: AppHandle) {
    std::thread::spawn(move || {
        let mut hide_at: Option<Instant> = None;
        let mut hiding = false;

        loop {
            let Some(state) = app.try_state::<IslandState>() else {
                return;
            };
            if state.quitting.load(Ordering::SeqCst) {
                return;
            }

            if !state.enabled.load(Ordering::SeqCst) {
                if state.shown.swap(false, Ordering::SeqCst) {
                    hide_window(&app);
                }
                hide_at = None;
                hiding = false;
                std::thread::sleep(Duration::from_millis(DISABLED_POLL_MS));
                continue;
            }

            if !state.ready.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(120));
                continue;
            }

            let Some(window) = app.get_webview_window(ISLAND_LABEL) else {
                std::thread::sleep(Duration::from_millis(500));
                continue;
            };
            let Some((x, y, w, h)) = island_rect(&app) else {
                std::thread::sleep(Duration::from_millis(500));
                continue;
            };
            let Ok(cursor) = app.cursor_position() else {
                std::thread::sleep(Duration::from_millis(200));
                continue;
            };

            let over = is_over_island(cursor.x, cursor.y, x, y, w, h);
            let pinned = state.is_pinned();

            if over || pinned {
                hide_at = None;
                let was_hiding = hiding;
                hiding = false;
                if !state.shown.load(Ordering::SeqCst) {
                    let _ = window.set_size(PhysicalSize::new(w, h));
                    let _ = window.set_position(PhysicalPosition::new(x, y));
                    let _ = window.show();
                    state.shown.store(true, Ordering::SeqCst);
                    let _ = app.emit(REVEAL_EVENT, ());
                } else if was_hiding {
                    let _ = app.emit(REVEAL_EVENT, ());
                }
            } else if state.shown.load(Ordering::SeqCst) {
                match hide_at {
                    None => hide_at = Some(Instant::now() + Duration::from_millis(HIDE_GRACE_MS)),
                    Some(deadline) if Instant::now() >= deadline => {
                        if !hiding {
                            hiding = true;
                            let _ = app.emit(HIDE_EVENT, ());
                            hide_at = Some(Instant::now() + Duration::from_millis(HIDE_ANIM_MS));
                        } else {
                            let _ = window.hide();
                            state.shown.store(false, Ordering::SeqCst);
                            hiding = false;
                            hide_at = None;
                        }
                    }
                    _ => {}
                }
            } else {
                hide_at = None;
            }

            std::thread::sleep(Duration::from_millis(POLL_MS));
        }
    });
}
