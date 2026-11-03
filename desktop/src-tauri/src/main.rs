//! Esmeringhoy — standalone Windows desktop music player.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api;
mod cache;
mod commands;
mod engine;
mod keystore;
mod state;

use state::AppState;
use std::sync::Arc;
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app
                .path()
                .app_local_data_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."));
            let app_state = AppState::new(&data_dir).expect("app state builds");
            app.manage(Arc::new(app_state));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::api_call,
            commands::auth_sign_in,
            commands::auth_register,
            commands::auth_restore,
            commands::auth_sign_out,
            commands::engine_load,
            commands::engine_toggle,
            commands::engine_seek,
            commands::engine_set_transport,
            commands::engine_stop,
            commands::engine_set_volume,
            commands::engine_state,
            commands::cache_clear,
            commands::app_health,
            commands::api_base,
            commands::web_log,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Esmeringhoy");
}
