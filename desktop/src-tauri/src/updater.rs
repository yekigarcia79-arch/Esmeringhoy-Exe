use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};
use tokio::io::AsyncWriteExt;

const UPDATE_API_LATEST: &str =
    "https://api.github.com/repos/yekigarcia79-arch/Esmeringhoy-Exe/releases/latest";
const UPDATE_DOWNLOAD_PREFIX: &str =
    "https://github.com/yekigarcia79-arch/Esmeringhoy-Exe/releases/download/";
const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const EMIT_MS: u64 = 140;
const CHECK_TTL: Duration = Duration::from_secs(600);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const HEADERS_TIMEOUT: Duration = Duration::from_secs(30);
const IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const CHUNK_WAIT: Duration = Duration::from_millis(400);
const MIN_FREE_MARGIN: u64 = 48 * 1024 * 1024;
const RUN_NONE: u8 = 0;
const RUN_PAUSE: u8 = 1;
const RUN_CANCEL: u8 = 2;

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Idle,
    Checking,
    Available,
    Preparing,
    Downloading,
    Paused,
    Verifying,
    Ready,
    Installing,
    Error,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    current_version: String,
    notes: String,
    published_at: String,
    asset_name: String,
    size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    checksum_url: Option<String>,
    url: String,
    html_url: String,
}

impl UpdateInfo {
    fn setup_file_name(&self) -> String {
        format!("Esmeringhoy_{}_x64-setup.exe", self.version)
    }
}

struct Inner {
    phase: Phase,
    info: Option<UpdateInfo>,
    downloaded: u64,
    total: Option<u64>,
    bytes_per_sec: f64,
    eta_secs: Option<u64>,
    error: Option<String>,
    verified: bool,
    signature: Option<String>,
    verified_hash: Option<String>,
}

impl Default for Inner {
    fn default() -> Self {
        Self {
            phase: Phase::Idle,
            info: None,
            downloaded: 0,
            total: None,
            bytes_per_sec: 0.0,
            eta_secs: None,
            error: None,
            verified: false,
            signature: None,
            verified_hash: None,
        }
    }
}

struct ActiveTask {
    id: u64,
    reason: Arc<AtomicU8>,
}

struct CheckCache {
    at: Instant,
    etag: Option<String>,
    info: Option<UpdateInfo>,
}

#[derive(Clone, Serialize, Deserialize)]
struct ResumeMeta {
    url: String,
    version: String,
    etag: Option<String>,
    last_modified: Option<String>,
    total: Option<u64>,
}

#[derive(Clone, Copy)]
struct ProgressTick {
    downloaded: u64,
    total: Option<u64>,
    speed: f64,
    eta: Option<u64>,
}

enum Failure {
    Paused,
    Cancelled,
    Error(String),
}

pub struct Updater {
    inner: Mutex<Inner>,
    task: Mutex<Option<ActiveTask>>,
    staging: PathBuf,
    data_dir: PathBuf,
    client: reqwest::Client,
    cache: Mutex<Option<CheckCache>>,
    next_task: AtomicU64,
}

impl Updater {
    pub fn new(data_dir: &Path) -> Arc<Self> {
        let staging = data_dir.join("updates");
        let _ = std::fs::create_dir_all(&staging);
        let client = reqwest::Client::builder()
            .user_agent(concat!("Esmeringhoy-Desktop/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(CONNECT_TIMEOUT)
            .read_timeout(IDLE_TIMEOUT)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Arc::new(Self {
            inner: Mutex::new(Inner::default()),
            task: Mutex::new(None),
            staging,
            data_dir: data_dir.to_path_buf(),
            client,
            cache: Mutex::new(None),
            next_task: AtomicU64::new(1),
        })
    }

    fn with_inner(&self, f: impl FnOnce(&mut Inner)) {
        let mut guard = self.inner.lock().unwrap();
        f(&mut guard);
    }

    fn snapshot(&self) -> Value {
        let inner = self.inner.lock().unwrap();
        let total = inner.total.or_else(|| inner.info.as_ref().map(|i| i.size));
        let percent = match inner.phase {
            Phase::Ready | Phase::Installing => Some(100u64),
            Phase::Preparing
            | Phase::Downloading
            | Phase::Paused
            | Phase::Verifying => total.and_then(|total| {
                if total == 0 {
                    None
                } else {
                    Some((inner.downloaded.saturating_mul(100) / total).min(99))
                }
            }),
            _ => None,
        };
        let info = inner.info.as_ref();
        json!({
            "phase": inner.phase,
            "available": info.is_some(),
            "currentVersion": CURRENT_VERSION,
            "info": info,
            "downloaded": inner.downloaded,
            "total": total,
            "percent": percent,
            "bytesPerSec": inner.bytes_per_sec.round(),
            "etaSecs": inner.eta_secs,
            "error": inner.error,
            "verified": inner.verified,
            "signature": inner.signature,
            "canInstall": can_self_update(),
        })
    }

    fn emit(&self, app: &AppHandle) {
        let _ = app.emit("update:state", self.snapshot());
    }

    fn finish_check(&self, app: &AppHandle, info: Option<UpdateInfo>) -> Value {
        let available = info.is_some();
        self.with_inner(|inner| {
            if let Some(info) = &info {
                inner.info = Some(info.clone());
                inner.total = Some(info.size);
            } else {
                inner.info = None;
                inner.total = None;
            }
            inner.phase = if available { Phase::Available } else { Phase::Idle };
            inner.downloaded = 0;
            inner.bytes_per_sec = 0.0;
            inner.eta_secs = None;
            inner.error = None;
            inner.verified = false;
            inner.signature = None;
            inner.verified_hash = None;
        });
        self.emit(app);
        self.snapshot()
    }

    pub async fn check(&self, app: &AppHandle, force: bool) -> Result<Value, String> {
        if self.task.lock().unwrap().is_some() {
            return Ok(self.snapshot());
        }
        {
            let inner = self.inner.lock().unwrap();
            if matches!(inner.phase, Phase::Paused | Phase::Ready) && inner.info.is_some() {
                return Ok(self.snapshot());
            }
        }
        if !force {
            if let Some(cache) = self.cache.lock().unwrap().as_ref() {
                if cache.at.elapsed() < CHECK_TTL {
                    return Ok(self.finish_check(app, cache.info.clone()));
                }
            }
        }

        self.with_inner(|inner| {
            inner.phase = Phase::Checking;
            inner.error = None;
        });
        self.emit(app);

        let etag = self
            .cache
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|cache| cache.etag.clone());

        let mut request = self
            .client
            .get(UPDATE_API_LATEST)
            .header("accept", "application/vnd.github+json")
            .header("x-github-api-version", "2022-11-28");
        if let Some(etag) = &etag {
            request = request.header("if-none-match", etag.clone());
        }

        let response = match tokio::time::timeout(HEADERS_TIMEOUT, request.send()).await {
            Err(_) => {
                let message = "The update check timed out. Check your connection and try again.";
                self.check_failed(app, message);
                return Err(message.into());
            }
            Ok(Err(err)) => {
                let message = format!("Could not reach the update server: {err}");
                self.check_failed(app, &message);
                return Err(message);
            }
            Ok(Ok(response)) => response,
        };

        let status = response.status();
        if status == 304 {
            let cached = self.cache.lock().unwrap().as_ref().map(|cache| cache.info.clone());
            return Ok(self.finish_check(app, cached.flatten()));
        }
        if status == 404 {
            return Ok(self.finish_check(app, None));
        }
        if !status.is_success() {
            let message = if status == 403 {
                "GitHub refused the update check (HTTP 403). Try again in a little while.".to_string()
            } else {
                format!("The update server answered HTTP {status}.")
            };
            self.check_failed(app, &message);
            return Err(message);
        }

        let new_etag = response
            .headers()
            .get("etag")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let body: Value = match tokio::time::timeout(HEADERS_TIMEOUT, response.json()).await {
            Err(_) => {
                let message = "The update server sent an incomplete response.";
                self.check_failed(app, message);
                return Err(message.into());
            }
            Ok(Err(err)) => {
                let message = format!("The update server sent unreadable release data: {err}");
                self.check_failed(app, &message);
                return Err(message);
            }
            Ok(Ok(body)) => body,
        };

        let info = match parse_release(&body) {
            Ok(info) => info,
            Err(message) => {
                self.check_failed(app, &message);
                return Err(message);
            }
        };

        *self.cache.lock().unwrap() = Some(CheckCache {
            at: Instant::now(),
            etag: new_etag,
            info: info.clone(),
        });
        Ok(self.finish_check(app, info))
    }

    fn check_failed(&self, app: &AppHandle, message: &str) {
        self.with_inner(|inner| {
            inner.phase = Phase::Idle;
            inner.error = Some(message.to_string());
            inner.bytes_per_sec = 0.0;
            inner.eta_secs = None;
        });
        self.emit(app);
    }

    pub fn start(self: &Arc<Self>, app: AppHandle) -> Result<(), String> {
        let mut task = self.task.lock().unwrap();
        if task.is_some() {
            return Err("An update download is already running.".into());
        }
        let info = {
            let inner = self.inner.lock().unwrap();
            if matches!(inner.phase, Phase::Checking | Phase::Preparing | Phase::Verifying | Phase::Installing) {
                return Err("The updater is busy.".into());
            }
            inner.info.clone()
        }
        .ok_or("Check for updates first.")?;
        if !is_newer_version(&info.version, CURRENT_VERSION) {
            return Err("This copy is already on the latest version.".into());
        }
        if !is_update_url(&info.url) {
            return Err("The update source is not trusted.".into());
        }

        let id = self.next_task.fetch_add(1, Ordering::SeqCst);
        let reason = Arc::new(AtomicU8::new(RUN_NONE));
        *task = Some(ActiveTask {
            id,
            reason: Arc::clone(&reason),
        });
        drop(task);

        self.with_inner(|inner| {
            inner.phase = Phase::Preparing;
            inner.error = None;
            inner.verified = false;
            inner.signature = None;
            inner.verified_hash = None;
            inner.bytes_per_sec = 0.0;
            inner.eta_secs = None;
        });
        self.emit(&app);

        let updater = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            updater.run_download(app, id, info, reason).await;
        });
        Ok(())
    }

    fn signal(&self, reason: u8) -> Result<(), String> {
        let task = self.task.lock().unwrap();
        match task.as_ref() {
            Some(task) => {
                task.reason.store(reason, Ordering::SeqCst);
                Ok(())
            }
            None => Err("No update is downloading right now.".into()),
        }
    }

    pub fn pause(&self) -> Result<(), String> {
        self.signal(RUN_PAUSE)
    }

    pub fn cancel(&self) -> Result<(), String> {
        self.signal(RUN_CANCEL)
    }

    fn finish_task(&self, id: u64) {
        let mut task = self.task.lock().unwrap();
        if task.as_ref().is_some_and(|task| task.id == id) {
            *task = None;
        }
    }

    async fn run_download(
        self: Arc<Self>,
        app: AppHandle,
        id: u64,
        info: UpdateInfo,
        reason: Arc<AtomicU8>,
    ) {
        let outcome = self.download_and_verify(&app, &info, &reason).await;

        match outcome {
            Ok(()) => {
                self.with_inner(|inner| {
                    inner.phase = Phase::Ready;
                    inner.verified = true;
                    inner.downloaded = info.size;
                    inner.total = Some(info.size);
                    inner.bytes_per_sec = 0.0;
                    inner.eta_secs = None;
                    inner.error = None;
                });
                self.emit(&app);
            }
            Err(Failure::Paused) => {
                self.with_inner(|inner| {
                    inner.phase = Phase::Paused;
                    inner.bytes_per_sec = 0.0;
                    inner.eta_secs = None;
                    inner.error = None;
                });
                self.emit(&app);
            }
            Err(Failure::Cancelled) => {
                let _ = tokio::fs::remove_file(self.part_path(&info.version)).await;
                let _ = tokio::fs::remove_file(self.meta_path(&info.version)).await;
                self.with_inner(|inner| {
                    inner.phase = if inner.info.is_some() { Phase::Available } else { Phase::Idle };
                    inner.downloaded = 0;
                    inner.bytes_per_sec = 0.0;
                    inner.eta_secs = None;
                    inner.error = None;
                    inner.verified = false;
                    inner.signature = None;
                    inner.verified_hash = None;
                });
                self.emit(&app);
            }
            Err(Failure::Error(message)) => {
                self.with_inner(|inner| {
                    inner.phase = Phase::Error;
                    inner.error = Some(message);
                    inner.bytes_per_sec = 0.0;
                    inner.eta_secs = None;
                });
                self.emit(&app);
            }
        }
        self.finish_task(id);
    }

    fn part_path(&self, version: &str) -> PathBuf {
        self.staging
            .join(format!("Esmeringhoy_{version}_x64-setup.exe.part"))
    }

    fn meta_path(&self, version: &str) -> PathBuf {
        self.staging
            .join(format!("Esmeringhoy_{version}_x64-setup.exe.part.json"))
    }

    fn setup_path(&self, info: &UpdateInfo) -> PathBuf {
        self.staging.join(info.setup_file_name())
    }

    async fn download_and_verify(
        &self,
        app: &AppHandle,
        info: &UpdateInfo,
        reason: &AtomicU8,
    ) -> Result<(), Failure> {
        let part = self.part_path(&info.version);
        let meta = self.meta_path(&info.version);
        let setup = self.setup_path(info);

        let size_of = |path: PathBuf| async move {
            tokio::fs::metadata(&path)
                .await
                .map(|m| m.len())
                .ok()
        };

        let mut source = None;
        if size_of(setup.clone()).await == Some(info.size) {
            source = Some(setup.clone());
        } else {
            if tokio::fs::metadata(&setup).await.is_ok() {
                let _ = tokio::fs::remove_file(&setup).await;
            }
            if size_of(part.clone()).await == Some(info.size) {
                source = Some(part.clone());
            }
        }

        if source.is_none() {
            if let Some(free) = free_bytes(&self.staging) {
                let needed = info.size.saturating_add(MIN_FREE_MARGIN);
                if free < needed {
                    return Err(Failure::Error(format!(
                        "Not enough free disk space: {} available, {} required.",
                        human_bytes(free),
                        human_bytes(needed)
                    )));
                }
            }

            let result = stream_download(
                &self.client,
                info,
                &part,
                &meta,
                reason,
                &mut |tick| {
                    self.with_inner(|inner| {
                        inner.phase = Phase::Downloading;
                        inner.downloaded = tick.downloaded;
                        inner.total = tick.total.or(Some(info.size));
                        inner.bytes_per_sec = tick.speed;
                        inner.eta_secs = tick.eta;
                    });
                    self.emit(app);
                },
            )
            .await;

            match result {
                Ok(_) => source = Some(part.clone()),
                Err(Failure::Paused) => return Err(Failure::Paused),
                Err(Failure::Cancelled) => return Err(Failure::Cancelled),
                Err(Failure::Error(message)) => return Err(Failure::Error(message)),
            }
        }

        let path = source.unwrap();
        self.with_inner(|inner| {
            inner.phase = Phase::Verifying;
            inner.downloaded = info.size;
            inner.total = Some(info.size);
            inner.bytes_per_sec = 0.0;
            inner.eta_secs = None;
        });
        self.emit(app);

        let hash = match sha256_file(&path).await {
            Ok(hash) => hash,
            Err(err) => {
                self.discard(&part, &meta, &setup).await;
                return Err(Failure::Error(format!(
                    "The downloaded package could not be read: {err}"
                )));
            }
        };

        let expected = if let Some(digest) = &info.digest {
            Some(digest.clone())
        } else if let Some(url) = &info.checksum_url {
            match fetch_checksum(&self.client, url, &info.asset_name).await {
                Ok(hash) => Some(hash),
                Err(err) => {
                    self.discard(&part, &meta, &setup).await;
                    return Err(Failure::Error(format!(
                        "The release checksum could not be fetched: {err}"
                    )));
                }
            }
        } else {
            None
        };

        let Some(expected) = expected else {
            self.discard(&part, &meta, &setup).await;
            return Err(Failure::Error(
                "This release does not publish a SHA-256 checksum, so the update cannot be verified."
                    .into(),
            ));
        };
        if !expected.eq_ignore_ascii_case(&hash) {
            self.discard(&part, &meta, &setup).await;
            return Err(Failure::Error(
                "The downloaded update failed its SHA-256 verification and was discarded.".into(),
            ));
        }

        let signature = authenticode_state(&path);
        if signature == SigState::Invalid {
            self.discard(&part, &meta, &setup).await;
            return Err(Failure::Error(
                "The update package's digital signature is invalid, so it was discarded.".into(),
            ));
        }

        if path == part {
            if tokio::fs::metadata(&setup).await.is_ok() {
                let _ = tokio::fs::remove_file(&setup).await;
            }
            tokio::fs::rename(&part, &setup).await.map_err(|err| {
                Failure::Error(format!("The verified package could not be staged: {err}"))
            })?;
            let _ = tokio::fs::remove_file(&meta).await;
        }

        self.with_inner(|inner| {
            inner.verified = true;
            inner.verified_hash = Some(hash);
            inner.signature = Some(match signature {
                SigState::Valid => "authenticode".to_string(),
                SigState::Unsigned => "unsigned".to_string(),
                _ => "unknown".to_string(),
            });
        });
        Ok(())
    }

    async fn discard(&self, part: &Path, meta: &Path, setup: &Path) {
        let _ = tokio::fs::remove_file(part).await;
        let _ = tokio::fs::remove_file(meta).await;
        let _ = tokio::fs::remove_file(setup).await;
    }

    pub async fn install(&self, app: &AppHandle) -> Result<(), String> {
        let (info, verified_hash) = {
            let inner = self.inner.lock().unwrap();
            if inner.phase != Phase::Ready || !inner.verified {
                return Err("The update has not been verified yet.".into());
            }
            let info = inner.info.clone().ok_or("No update is prepared.")?;
            let hash = inner
                .verified_hash
                .clone()
                .ok_or("The update has not been verified yet.")?;
            (info, hash)
        };
        if !is_newer_version(&info.version, CURRENT_VERSION) {
            return Err("That release would not upgrade this copy.".into());
        }
        if !can_self_update() {
            return Err("This copy was not installed by the setup program.".into());
        }
        let setup = self.setup_path(&info);
        if tokio::fs::metadata(&setup).await.map(|m| m.len()).ok() != Some(info.size) {
            return Err("The update package is missing from the staging folder.".into());
        }
        if sha256_file(&setup).await? != verified_hash {
            self.with_inner(|inner| {
                inner.phase = Phase::Error;
                inner.error = Some("The staged update package changed after verification.".into());
                inner.verified = false;
            });
            self.emit(app);
            let _ = tokio::fs::remove_file(&setup).await;
            return Err("The staged update package changed after verification.".into());
        }

        let exe = std::env::current_exe().map_err(|err| err.to_string())?;
        let script_path = self.staging.join("apply-update.ps1");
        let result_path = self.staging.join("install-result.txt");
        let pending_path = self.data_dir.join("update-pending.json");

        let started = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let pending = json!({
            "toVersion": info.version,
            "fromVersion": CURRENT_VERSION,
            "startedAt": started,
        });
        std::fs::write(
            &pending_path,
            serde_json::to_string_pretty(&pending).map_err(|err| err.to_string())?,
        )
        .map_err(|err| format!("Could not record the update state: {err}"))?;

        let quote = |path: &Path| -> Result<String, String> {
            let text = path.to_string_lossy().to_string();
            if text.contains(['\'', '"', '%', '\r', '\n']) {
                return Err("The update path cannot be used by the installer script.".to_string());
            }
            Ok(format!("'{text}'"))
        };
        let script = format!(
            "$ErrorActionPreference = 'SilentlyContinue'\r\n\
             $app = {app}\r\n\
             $setup = {setup}\r\n\
             $out = {out}\r\n\
             $appPid = {pid}\r\n\
             $deadline = (Get-Date).AddSeconds(180)\r\n\
             while ($true) {{\r\n\
               if (-not (Get-Process -Id $appPid -ErrorAction SilentlyContinue)) {{ break }}\r\n\
               if ((Get-Date) -gt $deadline) {{ break }}\r\n\
               Start-Sleep -Milliseconds 300\r\n\
             }}\r\n\
             $code = -1\r\n\
             try {{\r\n\
               $proc = Start-Process -FilePath $setup -ArgumentList '/S' -PassThru -Wait -WindowStyle Hidden\r\n\
               if ($proc) {{ $code = $proc.ExitCode }}\r\n\
             }} catch {{ $code = -1 }}\r\n\
             Set-Content -LiteralPath $out -Value $code\r\n\
             Start-Process -FilePath $app\r\n",
            app = quote(&exe)?,
            setup = quote(&setup)?,
            out = quote(&result_path)?,
            pid = std::process::id(),
        );
        std::fs::write(&script_path, script)
            .map_err(|err| format!("Could not write the installer script: {err}"))?;

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            std::process::Command::new("powershell")
                .args([
                    "-NoProfile",
                    "-WindowStyle",
                    "Hidden",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                ])
                .arg(&script_path)
                .creation_flags(0x08000000)
                .spawn()
                .map_err(|err| format!("Could not start the installer: {err}"))?;
        }
        #[cfg(not(windows))]
        {
            return Err("Installing updates is supported on Windows only.".into());
        }

        self.with_inner(|inner| {
            inner.phase = Phase::Installing;
            inner.bytes_per_sec = 0.0;
            inner.eta_secs = None;
        });
        self.emit(app);

        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(700)).await;
            handle.exit(0);
        });
        Ok(())
    }

    pub fn take_result(&self) -> Option<Value> {
        let pending_path = self.data_dir.join("update-pending.json");
        let raw = std::fs::read_to_string(&pending_path).ok()?;
        let pending: Value = serde_json::from_str(&raw).ok()?;
        let to = pending.get("toVersion").and_then(Value::as_str)?.to_string();
        let result_path = self.staging.join("install-result.txt");

        match (parse_version(CURRENT_VERSION), parse_version(&to)) {
            (Some(running), Some(target)) if running == target => {
                let _ = std::fs::remove_file(&pending_path);
                self.clean_staging();
                return Some(json!({
                    "status": "installed",
                    "version": to,
                    "currentVersion": CURRENT_VERSION,
                }));
            }
            (Some(running), Some(target)) if running > target => {
                // This copy is already newer than the pending update, so that
                // attempt is settled and must not be reported as a failure.
                let _ = std::fs::remove_file(&pending_path);
                let _ = std::fs::remove_file(&result_path);
                self.clean_staging();
                return None;
            }
            _ => {}
        }

        if let Ok(code) = std::fs::read_to_string(&result_path) {
            let _ = std::fs::remove_file(&pending_path);
            let _ = std::fs::remove_file(&result_path);
            let _ = std::fs::remove_file(self.staging.join("apply-update.ps1"));
            return Some(json!({
                "status": "failed",
                "version": to,
                "currentVersion": CURRENT_VERSION,
                "code": code.trim(),
            }));
        }

        let started = pending.get("startedAt").and_then(Value::as_u64).unwrap_or(0);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        if started > 0 && now.saturating_sub(started) > 3 * 60 * 60 * 1000 {
            let _ = std::fs::remove_file(&pending_path);
            return Some(json!({
                "status": "failed",
                "version": to,
                "currentVersion": CURRENT_VERSION,
                "code": "timeout",
            }));
        }
        None
    }

    fn clean_staging(&self) {
        if let Ok(entries) = std::fs::read_dir(&self.staging) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    let _ = std::fs::remove_file(path);
                }
            }
        }
    }
}

fn parse_version(raw: &str) -> Option<semver::Version> {
    let trimmed = raw.trim();
    let without_v = trimmed.strip_prefix(['v', 'V']).unwrap_or(trimmed);
    if let Ok(version) = semver::Version::parse(without_v) {
        return Some(version);
    }
    let core = without_v.split(['-', '+']).next().unwrap_or(without_v);
    let mut parts = core.split('.');
    let major = parts.next()?;
    let minor = parts.next().unwrap_or("0");
    let patch = parts.next().unwrap_or("0");
    semver::Version::parse(&format!("{major}.{minor}.{patch}")).ok()
}

fn is_newer_version(remote: &str, local: &str) -> bool {
    match (parse_version(remote), parse_version(local)) {
        (Some(remote), Some(local)) => remote > local,
        _ => false,
    }
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

fn safe_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment != "."
        && segment != ".."
        && segment
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn is_update_url(url: &str) -> bool {
    if url.len() > 2048
        || !url.starts_with(UPDATE_DOWNLOAD_PREFIX)
        || url.contains(['?', '#', '"', '<', '>', ' '])
    {
        return false;
    }
    let path = &url[UPDATE_DOWNLOAD_PREFIX.len()..];
    let segments: Vec<&str> = path.split('/').collect();
    if segments.len() < 2 || segments.iter().any(|segment| !safe_segment(segment)) {
        return false;
    }
    segments
        .last()
        .map(|asset| asset.to_ascii_lowercase().ends_with("-setup.exe"))
        .unwrap_or(false)
}

fn is_checksum_url(url: &str) -> bool {
    if url.len() > 2048
        || !url.starts_with(UPDATE_DOWNLOAD_PREFIX)
        || url.contains(['?', '#', '"', '<', '>', ' '])
    {
        return false;
    }
    let path = &url[UPDATE_DOWNLOAD_PREFIX.len()..];
    let segments: Vec<&str> = path.split('/').collect();
    if segments.len() < 2 || segments.iter().any(|segment| !safe_segment(segment)) {
        return false;
    }
    let name = segments.last().map(|name| name.to_ascii_lowercase()).unwrap_or_default();
    name.ends_with(".sha256") || name == "sha256sums" || name == "sha256sums.txt"
}

fn pick_setup_asset(assets: &[Value]) -> Option<&Value> {
    let setups: Vec<&Value> = assets
        .iter()
        .filter(|asset| {
            let name = asset.get("name").and_then(Value::as_str).unwrap_or("");
            let state = asset.get("state").and_then(Value::as_str).unwrap_or("uploaded");
            let url = asset
                .get("browser_download_url")
                .and_then(Value::as_str)
                .unwrap_or("");
            is_update_url(url) && state == "uploaded" && name.to_ascii_lowercase().ends_with("-setup.exe")
        })
        .collect();
    setups
        .iter()
        .find(|asset| {
            let name = asset
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_ascii_lowercase();
            name.contains("x64") || name.contains("x86_64") || name.contains("amd64")
        })
        .copied()
        .or_else(|| setups.first().copied())
}

fn asset_digest(asset: &Value) -> Option<String> {
    asset
        .get("digest")
        .and_then(Value::as_str)
        .and_then(|digest| digest.strip_prefix("sha256:"))
        .map(|hash| hash.trim().to_ascii_lowercase())
        .filter(|hash| hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit()))
}

fn checksum_asset_url(assets: &[Value]) -> Option<String> {
    assets
        .iter()
        .find(|asset| {
            let name = asset
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_ascii_lowercase();
            (name.ends_with(".sha256") || name == "sha256sums" || name == "sha256sums.txt")
                && asset.get("state").and_then(Value::as_str).unwrap_or("uploaded") == "uploaded"
        })
        .and_then(|asset| asset.get("browser_download_url"))
        .and_then(Value::as_str)
        .filter(|url| is_checksum_url(url))
        .map(str::to_string)
}

fn parse_release(body: &Value) -> Result<Option<UpdateInfo>, String> {
    let tag = body
        .get("tag_name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if tag.is_empty() {
        return Err("The latest release has no version tag.".into());
    }
    let remote = parse_version(tag)
        .ok_or_else(|| format!("The release tag {tag} is not a valid version number."))?;
    let current = parse_version(CURRENT_VERSION)
        .ok_or_else(|| "The installed version cannot be compared.".to_string())?;
    if remote <= current {
        return Ok(None);
    }

    let assets = body
        .get("assets")
        .and_then(Value::as_array)
        .ok_or_else(|| "The latest release does not list any files.".to_string())?;
    let asset = pick_setup_asset(assets)
        .ok_or_else(|| "The latest release has no Windows setup file.".to_string())?;

    let asset_name = asset
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let url = asset
        .get("browser_download_url")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let size = asset.get("size").and_then(Value::as_u64).unwrap_or(0);
    if size == 0 {
        return Err("The release setup file has no size information.".into());
    }

    let notes = body
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or("")
        .chars()
        .take(16_000)
        .collect::<String>();
    let published_at = body
        .get("published_at")
        .or_else(|| body.get("created_at"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let html_url = body
        .get("html_url")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    Ok(Some(UpdateInfo {
        version: remote.to_string(),
        current_version: CURRENT_VERSION.to_string(),
        notes,
        published_at,
        asset_name,
        size,
        digest: asset_digest(asset),
        checksum_url: checksum_asset_url(assets),
        url,
        html_url,
    }))
}

fn parse_content_range(value: &str) -> Option<(u64, Option<u64>)> {
    let value = value.trim().strip_prefix("bytes")?.trim();
    let (range, total) = value.split_once('/')?;
    let start = range.split('-').next()?.trim().parse::<u64>().ok()?;
    let total = total.trim();
    let total = if total == "*" {
        None
    } else {
        Some(total.parse::<u64>().ok()?)
    };
    Some((start, total))
}

struct RateMeter {
    samples: VecDeque<(Instant, u64)>,
    started: Instant,
    last_emit: Instant,
    last_data: Instant,
    speed: f64,
}

impl RateMeter {
    fn new(initial: u64) -> Self {
        let now = Instant::now();
        let mut samples = VecDeque::new();
        samples.push_back((now, initial));
        Self {
            samples,
            started: now,
            last_emit: now - Duration::from_millis(EMIT_MS),
            last_data: now,
            speed: 0.0,
        }
    }

    fn note(&mut self, downloaded: u64) {
        let now = Instant::now();
        self.last_data = now;
        self.samples.push_back((now, downloaded));
        while self
            .samples
            .front()
            .is_some_and(|(at, _)| now.duration_since(*at) > Duration::from_millis(2500))
            && self.samples.len() > 2
        {
            self.samples.pop_front();
        }
        if let Some((start, bytes)) = self.samples.front().copied() {
            let seconds = now.duration_since(start).as_secs_f64();
            if seconds > 0.2 {
                self.speed = downloaded.saturating_sub(bytes) as f64 / seconds;
            }
        }
    }

    fn eta(&self, downloaded: u64, total: Option<u64>) -> Option<u64> {
        let total = total?;
        if total <= downloaded {
            return Some(0);
        }
        if self.samples.len() < 3
            || self.started.elapsed() < Duration::from_millis(700)
            || self.speed < 1024.0
        {
            return None;
        }
        let remaining = ((total - downloaded) as f64 / self.speed).ceil() as u64;
        (remaining <= 86_400).then_some(remaining)
    }

    fn tick(&mut self, downloaded: u64, total: Option<u64>) -> Option<ProgressTick> {
        if self.last_emit.elapsed() < Duration::from_millis(EMIT_MS) {
            return None;
        }
        self.last_emit = Instant::now();
        Some(ProgressTick {
            downloaded,
            total,
            speed: self.speed,
            eta: self.eta(downloaded, total),
        })
    }
}

#[allow(clippy::too_many_arguments)]
async fn stream_download(
    client: &reqwest::Client,
    info: &UpdateInfo,
    part: &Path,
    meta_path: &Path,
    reason: &AtomicU8,
    on_progress: &mut (dyn FnMut(ProgressTick) + Send),
) -> Result<u64, Failure> {
    let expected_total = (info.size > 0).then_some(info.size);

    let mut resume = read_resume_meta(meta_path).filter(|meta| {
        meta.url == info.url
            && meta.version == info.version
            && meta.total.map_or(true, |total| total == info.size)
    });
    let mut offset = tokio::fs::metadata(part).await.map(|m| m.len()).unwrap_or(0);
    if offset > 0 && expected_total.is_some_and(|total| offset > total) {
        let _ = tokio::fs::remove_file(part).await;
        let _ = tokio::fs::remove_file(meta_path).await;
        resume = None;
        offset = 0;
    }
    if offset == 0 {
        resume = None;
    }
    if let Some(total) = expected_total {
        if offset == total {
            return Ok(offset);
        }
    }

    let mut fresh_attempt = true;
    loop {
        let mut request = client.get(&info.url);
        if offset > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={offset}-"));
            if let Some(meta) = &resume {
                if let Some(etag) = &meta.etag {
                    request = request.header(reqwest::header::IF_RANGE, etag.clone());
                } else if let Some(modified) = &meta.last_modified {
                    request = request.header(reqwest::header::IF_RANGE, modified.clone());
                }
            }
        }

        let response = tokio::select! {
            response = tokio::time::timeout(HEADERS_TIMEOUT, request.send()) => {
                match response {
                    Err(_) => return Err(Failure::Error(
                        "The update server took too long to respond.".into(),
                    )),
                    Ok(Err(err)) => return Err(Failure::Error(format!(
                        "Could not download the update: {err}"
                    ))),
                    Ok(Ok(response)) => response,
                }
            }
            _ = wait_for_signal(reason) => {
                return Err(match reason.load(Ordering::SeqCst) {
                    RUN_PAUSE => Failure::Paused,
                    _ => Failure::Cancelled,
                });
            }
        };

        let status = response.status();
        if status == 416 && offset > 0 && fresh_attempt {
            fresh_attempt = false;
            let _ = tokio::fs::remove_file(part).await;
            let _ = tokio::fs::remove_file(meta_path).await;
            resume = None;
            offset = 0;
            continue;
        }

        let mut total = expected_total;
        if status == 206 {
            let Some(range) = response
                .headers()
                .get(reqwest::header::CONTENT_RANGE)
                .and_then(|value| value.to_str().ok())
            else {
                let _ = tokio::fs::remove_file(part).await;
                return Err(Failure::Error(
                    "The update server sent a resume response without a byte range.".into(),
                ));
            };
            let Some((start, range_total)) = parse_content_range(range) else {
                let _ = tokio::fs::remove_file(part).await;
                return Err(Failure::Error(
                    "The update server sent an unreadable byte range.".into(),
                ));
            };
            if start != offset {
                let _ = tokio::fs::remove_file(part).await;
                return Err(Failure::Error(
                    "The update server resumed from the wrong position.".into(),
                ));
            }
            if let (Some(remote), Some(expected)) = (range_total, expected_total) {
                if remote != expected {
                    let _ = tokio::fs::remove_file(part).await;
                    return Err(Failure::Error(
                        "The update file size changed on the server. Try again.".into(),
                    ));
                }
            }
            if range_total.is_some() {
                total = range_total;
            }
        } else if status.is_success() {
            offset = 0;
            if let Some(length) = response.content_length() {
                if expected_total.is_some_and(|expected| length != expected) {
                    let _ = tokio::fs::remove_file(part).await;
                    return Err(Failure::Error(format!(
                        "The update server offered {} instead of the expected {}.",
                        human_bytes(length),
                        human_bytes(info.size)
                    )));
                }
                total = Some(length);
            }
        } else {
            return Err(Failure::Error(format!(
                "The update server answered HTTP {status}."
            )));
        }

        let mut file = if offset > 0 {
            match tokio::fs::OpenOptions::new().append(true).open(part).await {
                Ok(file) => file,
                Err(err) => {
                    return Err(Failure::Error(format!(
                        "The partial download could not be opened: {err}"
                    )))
                }
            }
        } else {
            match tokio::fs::File::create(part).await {
                Ok(file) => file,
                Err(err) => {
                    return Err(Failure::Error(format!(
                        "The update file could not be created: {err}"
                    )))
                }
            }
        };

        let meta = ResumeMeta {
            url: info.url.clone(),
            version: info.version.clone(),
            etag: response
                .headers()
                .get(reqwest::header::ETAG)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string),
            last_modified: response
                .headers()
                .get(reqwest::header::LAST_MODIFIED)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string),
            total,
        };
        let _ = write_resume_meta(meta_path, &meta).await;

        let mut downloaded = offset;
        let mut meter = RateMeter::new(offset);
        on_progress(ProgressTick {
            downloaded,
            total,
            speed: 0.0,
            eta: None,
        });
        let mut stream = response.bytes_stream();

        loop {
            match reason.load(Ordering::SeqCst) {
                RUN_PAUSE => {
                    let _ = file.flush().await;
                    let _ = file.sync_all().await;
                    return Err(Failure::Paused);
                }
                RUN_CANCEL => {
                    let _ = file.flush().await;
                    return Err(Failure::Cancelled);
                }
                _ => {}
            }
            let next = match tokio::time::timeout(CHUNK_WAIT, stream.next()).await {
                Err(_) => {
                    if meter.last_data.elapsed() > IDLE_TIMEOUT {
                        let _ = file.flush().await;
                        return Err(Failure::Error(
                            "The download stalled for 30 seconds. Retry to resume it.".into(),
                        ));
                    }
                    continue;
                }
                Ok(next) => next,
            };
            match next {
                None => break,
                Some(Err(err)) => {
                    let _ = file.flush().await;
                    return Err(Failure::Error(format!(
                        "The download was interrupted: {err}. Retry to resume it."
                    )));
                }
                Some(Ok(chunk)) => {
                    if let Err(err) = file.write_all(&chunk).await {
                        let full = err.raw_os_error() == Some(112);
                        return Err(Failure::Error(if full {
                            "The disk is full. Free some space and retry the download.".into()
                        } else {
                            format!("The update file could not be written: {err}")
                        }));
                    }
                    downloaded += chunk.len() as u64;
                    meter.note(downloaded);
                    if let Some(tick) = meter.tick(downloaded, total) {
                        on_progress(tick);
                    }
                }
            }
        }

        if let Err(err) = file.flush().await {
            return Err(Failure::Error(format!(
                "The update file could not be saved: {err}"
            )));
        }
        if let Err(err) = file.sync_all().await {
            return Err(Failure::Error(format!(
                "The update file could not be saved: {err}"
            )));
        }

        if let Some(total) = total {
            if downloaded != total {
                on_progress(ProgressTick {
                    downloaded,
                    total: Some(total),
                    speed: meter.speed,
                    eta: meter.eta(downloaded, Some(total)),
                });
                return Err(Failure::Error(format!(
                    "The download stopped early at {} of {}. Retry to resume it.",
                    human_bytes(downloaded),
                    human_bytes(total)
                )));
            }
        }

        on_progress(ProgressTick {
            downloaded,
            total,
            speed: meter.speed,
            eta: Some(0),
        });
        return Ok(downloaded);
    }
}

async fn wait_for_signal(reason: &AtomicU8) {
    loop {
        if reason.load(Ordering::SeqCst) != RUN_NONE {
            return;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

fn read_resume_meta(path: &Path) -> Option<ResumeMeta> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

async fn write_resume_meta(path: &Path, meta: &ResumeMeta) -> Result<(), std::io::Error> {
    let raw = serde_json::to_string(meta).unwrap_or_default();
    tokio::fs::write(path, raw).await
}

async fn sha256_file(path: &Path) -> Result<String, String> {
    use tokio::io::AsyncReadExt;
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|err| err.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .await
            .map_err(|err| err.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

async fn fetch_checksum(
    client: &reqwest::Client,
    url: &str,
    asset_name: &str,
) -> Result<String, String> {
    let response = tokio::time::timeout(HEADERS_TIMEOUT, client.get(url).send())
        .await
        .map_err(|_| "checksum request timed out".to_string())?
        .map_err(|err| err.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }
    let body = tokio::time::timeout(HEADERS_TIMEOUT, response.text())
        .await
        .map_err(|_| "checksum response timed out".to_string())?
        .map_err(|err| err.to_string())?;
    if body.len() > 128 * 1024 {
        return Err("the checksum file is unexpectedly large".into());
    }
    for line in body.lines() {
        let mut parts = line.split_whitespace();
        let Some(hash) = parts.next() else { continue };
        if hash.len() != 64 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
            continue;
        }
        let name = parts.next().unwrap_or("").trim_start_matches('*');
        if name == asset_name {
            return Ok(hash.to_ascii_lowercase());
        }
    }
    Err("no checksum for this update file was found".into())
}

fn human_bytes(n: u64) -> String {
    const MB: f64 = 1024.0 * 1024.0;
    if n >= 1024 * 1024 {
        format!("{:.1} MB", n as f64 / MB)
    } else if n >= 1024 {
        format!("{:.0} KB", n as f64 / 1024.0)
    } else {
        format!("{n} B")
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SigState {
    Valid,
    Unsigned,
    Invalid,
}

#[cfg(windows)]
fn authenticode_state(path: &Path) -> SigState {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Security::WinTrust::{
        WinVerifyTrust, WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA, WINTRUST_FILE_INFO,
        WTD_CHOICE_FILE, WTD_REVOKE_NONE, WTD_STATEACTION_CLOSE, WTD_STATEACTION_VERIFY,
        WTD_UI_NONE,
    };
    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut file_info: WINTRUST_FILE_INFO = unsafe { std::mem::zeroed() };
    file_info.cbStruct = std::mem::size_of::<WINTRUST_FILE_INFO>() as u32;
    file_info.pcwszFilePath = wide.as_ptr();
    let mut data: WINTRUST_DATA = unsafe { std::mem::zeroed() };
    data.cbStruct = std::mem::size_of::<WINTRUST_DATA>() as u32;
    data.dwUIChoice = WTD_UI_NONE;
    data.fdwRevocationChecks = WTD_REVOKE_NONE;
    data.dwUnionChoice = WTD_CHOICE_FILE;
    data.dwStateAction = WTD_STATEACTION_VERIFY;
    data.Anonymous.pFile = &mut file_info;
    let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    let status = unsafe {
        WinVerifyTrust(
            std::ptr::null_mut(),
            &mut action,
            &mut data as *mut _ as *mut _,
        )
    };
    data.dwStateAction = WTD_STATEACTION_CLOSE;
    unsafe {
        WinVerifyTrust(
            std::ptr::null_mut(),
            &mut action,
            &mut data as *mut _ as *mut _,
        );
    }
    if status == 0 {
        SigState::Valid
    } else if matches!(
        status as u32,
        0x800B_0100 | 0x800B_0003 | 0x800B_0001
    ) {
        SigState::Unsigned
    } else {
        SigState::Invalid
    }
}

#[cfg(not(windows))]
fn authenticode_state(_path: &Path) -> SigState {
    SigState::Invalid
}

#[cfg(windows)]
fn free_bytes(dir: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let wide: Vec<u16> = dir
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut free = 0u64;
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut free,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    (ok != 0).then_some(free)
}

#[cfg(not(windows))]
fn free_bytes(_dir: &Path) -> Option<u64> {
    None
}

#[tauri::command]
pub async fn check_update(
    app: AppHandle,
    updater: State<'_, Arc<Updater>>,
    force: Option<bool>,
) -> Result<Value, String> {
    updater.check(&app, force.unwrap_or(false)).await
}

#[tauri::command]
pub fn update_state(updater: State<'_, Arc<Updater>>) -> Value {
    updater.snapshot()
}

#[tauri::command]
pub fn start_update_download(app: AppHandle, updater: State<'_, Arc<Updater>>) -> Result<(), String> {
    let updater = Arc::clone(&updater);
    updater.start(app)
}

#[tauri::command]
pub fn pause_update(updater: State<'_, Arc<Updater>>) -> Result<(), String> {
    updater.pause()
}

#[tauri::command]
pub fn cancel_update(updater: State<'_, Arc<Updater>>) -> Result<(), String> {
    updater.cancel()
}

#[tauri::command]
pub async fn install_update(app: AppHandle, updater: State<'_, Arc<Updater>>) -> Result<(), String> {
    updater.install(&app).await
}

#[tauri::command]
pub fn update_take_result(updater: State<'_, Arc<Updater>>) -> Option<Value> {
    updater.take_result()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_versions_semantically() {
        assert!(is_newer_version("1.0.2", "1.0.1"));
        assert!(is_newer_version("v1.0.10", "1.0.9"));
        assert!(is_newer_version("1.1.0", "1.0.99"));
        assert!(!is_newer_version("1.0.1", "1.0.1"));
        assert!(!is_newer_version("1.0.0", "1.0.1"));
        assert!(!is_newer_version("garbage", "1.0.1"));
        assert!(parse_version("v2.0").is_some());
        assert!(parse_version("2").is_some());
        assert!(parse_version("2.0.0-beta.1") < parse_version("2.0.0"));
    }

    #[test]
    fn only_trusts_release_urls() {
        let good = "https://github.com/yekigarcia79-arch/Esmeringhoy-Exe/releases/download/v1.0.2/Esmeringhoy_1.0.2_x64-setup.exe";
        assert!(is_update_url(good));
        assert!(!is_update_url("http://github.com/yekigarcia79-arch/Esmeringhoy-Exe/releases/download/v1.0.2/a-setup.exe"));
        assert!(!is_update_url("https://evil.example/yekigarcia79-arch/Esmeringhoy-Exe/releases/download/v1.0.2/a-setup.exe"));
        assert!(!is_update_url("https://github.com/yekigarcia79-arch/Esmeringhoy-Exe/releases/download/v1.0.2/a.msi"));
        assert!(!is_update_url("https://github.com/yekigarcia79-arch/Esmeringhoy-Exe/releases/download/../v1.0.2/a-setup.exe"));
        assert!(!is_update_url("https://github.com/yekigarcia79-arch/Esmeringhoy-Exe/releases/download/v1.0.2/a-setup.exe?x=1"));
        let checksum = "https://github.com/yekigarcia79-arch/Esmeringhoy-Exe/releases/download/v1.0.2/SHA256SUMS.txt";
        assert!(is_checksum_url(checksum));
    }

    #[test]
    fn reads_content_ranges() {
        assert_eq!(parse_content_range("bytes 100-199/500"), Some((100, Some(500))));
        assert_eq!(parse_content_range("bytes 0-9/*"), Some((0, None)));
        assert_eq!(parse_content_range("nonsense"), None);
    }

    #[test]
    fn accepts_only_sha256_digests() {
        let digest = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        assert_eq!(
            asset_digest(&json!({ "digest": digest })),
            Some("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into())
        );
        assert_eq!(asset_digest(&json!({ "digest": "sha512:abcd" })), None);
        assert_eq!(asset_digest(&json!({ "digest": null })), None);
    }

    fn test_info(url: &str, size: u64) -> UpdateInfo {
        UpdateInfo {
            version: "1.0.3".into(),
            current_version: "1.0.2".into(),
            notes: String::new(),
            published_at: String::new(),
            asset_name: "Esmeringhoy_1.0.3_x64-setup.exe".into(),
            size,
            digest: None,
            checksum_url: None,
            url: url.into(),
            html_url: String::new(),
        }
    }

    fn test_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "esm-updater-test-{}-{tag}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    async fn serve_payload(payload: Vec<u8>) -> (String, Arc<std::sync::atomic::AtomicBool>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let saw_range = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = Arc::clone(&saw_range);
        tokio::spawn(async move {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let mut request = vec![0u8; 16 * 1024];
            let mut filled = 0;
            loop {
                let read = socket.read(&mut request[filled..]).await.unwrap_or(0);
                if read == 0 {
                    break;
                }
                filled += read;
                if request[..filled]
                    .windows(4)
                    .any(|window| window == b"\r\n\r\n")
                {
                    break;
                }
                if filled >= request.len() {
                    break;
                }
            }
            let head = String::from_utf8_lossy(&request[..filled]).to_string();
            let mut start = 0usize;
            for line in head.lines() {
                let lower = line.to_ascii_lowercase();
                if let Some(rest) = lower.trim().strip_prefix("range: bytes=") {
                    start = rest
                        .split('-')
                        .next()
                        .unwrap_or("0")
                        .trim()
                        .parse()
                        .unwrap_or(0);
                    flag.store(true, Ordering::SeqCst);
                }
            }
            let body = &payload[start.min(payload.len())..];
            let header = if start > 0 {
                format!(
                    "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {}-{}/{}\r\nConnection: close\r\n\r\n",
                    body.len(),
                    start,
                    payload.len().saturating_sub(1),
                    payload.len()
                )
            } else {
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
            };
            let _ = socket.write_all(header.as_bytes()).await;
            let _ = socket.write_all(body).await;
            let _ = socket.shutdown().await;
        });
        (format!("http://{address}/Esmeringhoy_1.0.3_x64-setup.exe"), saw_range)
    }

    fn sample_payload(size: usize) -> Vec<u8> {
        (0..size).map(|index| (index % 251) as u8).collect()
    }

    #[tokio::test]
    async fn streams_a_fresh_download_to_disk() {
        let payload = sample_payload(300 * 1024);
        let (url, _) = serve_payload(payload.clone()).await;
        let dir = test_dir("fresh");
        let part = dir.join("update.exe.part");
        let meta = dir.join("update.exe.part.json");
        let info = test_info(&url, payload.len() as u64);
        let client = reqwest::Client::new();
        let reason = AtomicU8::new(RUN_NONE);
        let mut ticks = 0u32;

        let result = stream_download(&client, &info, &part, &meta, &reason, &mut |tick| {
            ticks += 1;
            assert!(tick.downloaded <= tick.total.unwrap_or(u64::MAX));
        })
        .await;

        match result {
            Ok(downloaded) => assert_eq!(downloaded, payload.len() as u64),
            Err(_) => panic!("fresh download failed"),
        }
        assert!(ticks >= 1);
        assert_eq!(std::fs::read(&part).unwrap(), payload);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn resumes_from_a_validated_partial_file() {
        let payload = sample_payload(512 * 1024);
        let offset = 200 * 1024;
        let (url, saw_range) = serve_payload(payload.clone()).await;
        let dir = test_dir("resume");
        let part = dir.join("update.exe.part");
        let meta = dir.join("update.exe.part.json");
        std::fs::write(&part, &payload[..offset]).unwrap();
        let resume = ResumeMeta {
            url: url.clone(),
            version: "1.0.3".into(),
            etag: Some("\"etag-1\"".into()),
            last_modified: None,
            total: Some(payload.len() as u64),
        };
        std::fs::write(&meta, serde_json::to_string(&resume).unwrap()).unwrap();
        let info = test_info(&url, payload.len() as u64);
        let client = reqwest::Client::new();
        let reason = AtomicU8::new(RUN_NONE);

        let result =
            stream_download(&client, &info, &part, &meta, &reason, &mut |_| {}).await;

        match result {
            Ok(downloaded) => assert_eq!(downloaded, payload.len() as u64),
            Err(_) => panic!("resumed download failed"),
        }
        assert!(saw_range.load(Ordering::SeqCst), "server never saw a Range request");
        assert_eq!(std::fs::read(&part).unwrap(), payload);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn cancellation_stops_before_writing() {
        let payload = sample_payload(128 * 1024);
        let (url, _) = serve_payload(payload.clone()).await;
        let dir = test_dir("cancel");
        let part = dir.join("update.exe.part");
        let meta = dir.join("update.exe.part.json");
        let info = test_info(&url, payload.len() as u64);
        let client = reqwest::Client::new();
        let reason = AtomicU8::new(RUN_CANCEL);

        let result =
            stream_download(&client, &info, &part, &meta, &reason, &mut |_| {}).await;

        assert!(matches!(result, Err(Failure::Cancelled)));
        assert!(!part.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
