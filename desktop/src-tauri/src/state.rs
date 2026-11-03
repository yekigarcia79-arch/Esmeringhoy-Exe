use crate::api::ApiClient;
use crate::cache::TrackCache;
use crate::engine::Engine;
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

#[derive(Clone, Serialize, Deserialize)]
pub struct Prefs {
    pub volume: f32,
    #[serde(default = "default_cache_gb")]
    pub cache_limit_gb: u64,
}

impl Default for Prefs {
    fn default() -> Self {
        Self { volume: 0.7, cache_limit_gb: DEFAULT_CACHE_GB }
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
    pub prefs: Mutex<Prefs>,
    pub prefs_path: PathBuf,
}

impl AppState {
    pub fn new(data_dir: &Path) -> Result<Self> {
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
        let engine = Arc::new(Engine::new(prefs.volume).context("audio engine failed to start")?);

        Ok(Self { api, cache, engine, prefs: Mutex::new(prefs), prefs_path })
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
