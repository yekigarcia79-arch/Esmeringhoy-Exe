#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api;
mod cache;
mod commands;
mod discord;
mod engine;
mod keystore;
mod preload;
mod state;
mod youtube;

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
            commands::artist_thumb,
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
            commands::cache_stats,
            commands::cache_set_limit,
            commands::cached_tracks,
            commands::cache_download_all,
            commands::cache_preload,
            commands::preload_status,
            commands::app_health,
            commands::check_update,
            commands::install_update,
            commands::open_url,
            commands::settings_get,
            commands::general_set,
            commands::appearance_set,
            commands::discord_rpc_set,
            commands::discord_rpc_sync,
            commands::api_base,
            commands::web_log,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Esmeringhoy");
}
