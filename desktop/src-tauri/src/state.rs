//! Shared application state: API client, audio engine, track cache, and the
//! small persistent settings file (volume). Managed as one Arc-<AppState>.

use crate::api::ApiClient;
use crate::cache::TrackCache;
use crate::engine::Engine;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub const CACHE_CAP_BYTES: u64 = 1024 * 1024 * 1024; // 1 GB
pub const ENV_API_BASE: &str = "ESM_API_BASE";

#[derive(Clone, Serialize, Deserialize)]
pub struct Prefs {
    pub volume: f32,
}

impl Default for Prefs {
    fn default() -> Self {
        Self { volume: 0.7 }
    }
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
        let cache = Arc::new(TrackCache::new(cache_dir, CACHE_CAP_BYTES));

        // ESM_API_BASE overrides the backend for local development
        // (e.g. http://127.0.0.1:8788 with `npm start` in the web repo).
        let base = std::env::var(ENV_API_BASE).unwrap_or_else(|_| crate::api::DEFAULT_BASE_URL.to_string());
        let api = Arc::new(ApiClient::new(&base));
        let engine = Arc::new(Engine::new(prefs.volume).context("audio engine failed to start")?);

        Ok(Self { api, cache, engine, prefs: Mutex::new(prefs), prefs_path })
    }

    pub fn save_prefs(&self) -> Result<()> {
        let prefs = self.prefs.lock().unwrap().clone();
        let tmp = self.prefs_path.with_extension("tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(&prefs)?).context("writing settings")?;
        std::fs::rename(&tmp, &self.prefs_path).context("committing settings")?;
        Ok(())
    }
}
