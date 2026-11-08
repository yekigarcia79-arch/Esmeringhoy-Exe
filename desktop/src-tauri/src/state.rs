use crate::api::ApiClient;
use crate::cache::TrackCache;
use crate::discord::DiscordRpc;
use crate::engine::Engine;
use crate::preload::Preloader;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub const DEFAULT_CACHE_GB: u64 = 5;
pub const CACHE_GB_CHOICES: [u64; 2] = [5, 10];
pub const ENV_API_BASE: &str = "ESM_API_BASE";

fn default_cache_gb() -> u64 {
    DEFAULT_CACHE_GB
}

fn default_true() -> bool {
    true
}

fn default_logo() -> String {
    "logo".to_string()
}

fn default_discord_client_id() -> String {
    "1568194603189010562".to_string()
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Prefs {
    pub volume: f32,
    #[serde(default = "default_cache_gb")]
    pub cache_limit_gb: u64,
    #[serde(default = "default_true")]
    pub auto_update_check: bool,
    #[serde(default = "default_true")]
    pub ambient_artwork: bool,
    #[serde(default)]
    pub reduce_motion: bool,
    #[serde(default)]
    pub discord_rpc_enabled: bool,
    #[serde(default = "default_discord_client_id")]
    pub discord_client_id: String,
    #[serde(default = "default_logo")]
    pub discord_large_image_key: String,
    #[serde(default = "default_logo")]
    pub discord_small_image_key: String,
}

impl Default for Prefs {
    fn default() -> Self {
        Self {
            volume: 0.7,
            cache_limit_gb: DEFAULT_CACHE_GB,
            auto_update_check: true,
            ambient_artwork: true,
            reduce_motion: false,
            discord_rpc_enabled: false,
            discord_client_id: default_discord_client_id(),
            discord_large_image_key: default_logo(),
            discord_small_image_key: default_logo(),
        }
    }
}

pub fn cache_cap_bytes(gb: u64) -> u64 {
    let gb = if CACHE_GB_CHOICES.contains(&gb) { gb } else { DEFAULT_CACHE_GB };
    gb * 1024 * 1024 * 1024
}

pub struct AppState {
    pub api: Arc<ApiClient>,
    pub cache: Arc<TrackCache>,
    pub engine: Arc<Engine>,
    pub discord: Arc<DiscordRpc>,
    pub preloader: Arc<Preloader>,
    pub prefs: Mutex<Prefs>,
    pub prefs_path: PathBuf,
}

impl AppState {
    pub fn new(data_dir: &Path, app: &tauri::AppHandle) -> Result<Self> {
        std::fs::create_dir_all(data_dir).context("creating data dir")?;

        let prefs_path = data_dir.join("settings.json");
        let prefs: Prefs = std::fs::read_to_string(&prefs_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();

        let cache_dir = data_dir.join("cache");
        let cache = Arc::new(TrackCache::new(cache_dir, cache_cap_bytes(prefs.cache_limit_gb)));

        let base = std::env::var(ENV_API_BASE).unwrap_or_else(|_| crate::api::DEFAULT_BASE_URL.to_string());
        let api = Arc::new(ApiClient::new(&base));
        let prefs_for_rpc = prefs.clone();
        let engine = Arc::new(Engine::new(prefs.volume).context("audio engine failed to start")?);
        let discord = Arc::new(DiscordRpc::new(&prefs_for_rpc, app.clone()));
        let preloader = Preloader::new(Arc::clone(&api), Arc::clone(&cache));

        Ok(Self { api, cache, engine, discord, preloader, prefs: Mutex::new(prefs), prefs_path })
    }

    pub fn set_cache_limit(&self, gb: u64) -> Result<()> {
        let gb = if CACHE_GB_CHOICES.contains(&gb) { gb } else { DEFAULT_CACHE_GB };
        self.cache.set_cap(cache_cap_bytes(gb));
        self.prefs.lock().unwrap().cache_limit_gb = gb;
        self.save_prefs()
    }

    pub fn save_prefs(&self) -> Result<()> {
        let prefs = self.prefs.lock().unwrap().clone();
        let tmp = self.prefs_path.with_extension("tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(&prefs)?).context("writing settings")?;
        std::fs::rename(&tmp, &self.prefs_path).context("committing settings")?;
        Ok(())
    }
}
