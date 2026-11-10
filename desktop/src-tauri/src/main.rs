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
            let app_state = AppState::new(&data_dir, app.handle()).expect("app state builds");
            app.manage(Arc::new(app_state));

            // Alt-Tab and the taskbar read the window's own icon, not the
            // executable's resources. Tauri normally copies it across from the
            // .ico at creation, which left this window with the generic
            // placeholder, so set it here from the bundled PNG as well — the
            // window then has an icon whatever the resource lookup did.
            if let Some(window) = app.get_webview_window("main") {
                let icon = app
                    .default_window_icon()
                    .cloned()
                    .or_else(|| {
                        tauri::image::Image::from_bytes(include_bytes!("../icons/128x128@2x.png")).ok()
                    });
                match icon {
                    Some(icon) => {
                        if let Err(e) = window.set_icon(icon) {
                            eprintln!("could not set the window icon: {e}");
                        }
                    }
                    None => eprintln!("no window icon available"),
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::api_call,
            commands::artist_thumb,
            commands::auth_sign_in,
            commands::auth_register,
            commands::auth_email_start,
            commands::auth_email_verify,
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
            commands::waveforms_set,
            commands::waveform_peaks,
            commands::discord_rpc_set,
            commands::discord_rpc_sync,
            commands::api_base,
            commands::web_log,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Esmeringhoy");
}
