//! HTTP client for the Esmeringhoy backend (the open-source web player's
//! API). The desktop is a first-party client: it logs in with the session
//! token in `Authorization: Bearer …`, never with cookies.
//!
//! Every request the UI makes goes through `ApiClient::call`, so the token
//! never reaches the webview. Large binary downloads use `download_to_file`.

use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use reqwest::{Client, Method};
use serde_json::Value;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const DEFAULT_BASE_URL: &str = "https://esmeringhoy.pages.dev";

#[derive(Clone)]
pub struct ApiClient {
    base_url: String,
    http: Client,
    token: Arc<Mutex<Option<String>>>,
}

pub struct ApiResponse {
    pub status: u16,
    pub json: Value,
}

impl ApiResponse {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

impl ApiClient {
    pub fn new(base_url: &str) -> Self {
        let http = Client::builder()
            .timeout(Duration::from_secs(30))
            .user_agent(concat!("Esmeringhoy-Desktop/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("reqwest client builds");
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            http,
            token: Arc::new(Mutex::new(None)),
        }
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub fn set_token(&self, token: Option<String>) {
        *self.token.lock().unwrap() = token;
    }

    pub fn token(&self) -> Option<String> {
        self.token.lock().unwrap().clone()
    }

    /// JSON request with optional body. Auth is attached when present.
    pub async fn call(&self, method: &str, path: &str, body: Option<Value>) -> Result<ApiResponse> {
        let method = Method::from_bytes(method.as_bytes()).context("bad http method")?;
        let url = format!("{}/{}", self.base_url, path.trim_start_matches('/'));
        let mut req = self.http.request(method, &url);
        if let Some(b) = &body {
            req = req.json(b);
        }
        if let Some(t) = self.token() {
            req = req.bearer_auth(t);
        }
        let res = req.send().await.context("request failed")?;
        let status = res.status().as_u16();
        let bytes = res.bytes().await.context("reading body")?;
        let json: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        Ok(ApiResponse { status, json })
    }

    /// GET a text/plain or json endpoint without a body — same as `call`.
    pub async fn get(&self, path: &str) -> Result<ApiResponse> {
        self.call("GET", path, None).await
    }

    /// Stream a (typically large) binary resource to disk with progress
    /// callbacks. Returns the number of bytes written.
    pub async fn download_to_file(
        &self,
        path: &str,
        dest: &Path,
        on_progress: impl FnMut(u64, Option<u64>),
    ) -> Result<u64> {
        let url = format!("{}/{}", self.base_url, path.trim_start_matches('/'));
        let mut req = self.http.get(&url);
        if let Some(t) = self.token() {
            req = req.bearer_auth(t);
        }
        let res = req.send().await.context("download request failed")?;
        let status = res.status();
        if !status.is_success() {
            let code = status.as_u16();
            let body = res.text().await.unwrap_or_default();
            return Err(anyhow!("download failed: HTTP {code} {}", body.trim()));
        }
        Ok(Self::stream_to_file(res, dest, on_progress).await?.0)
    }

    /// Download an absolute url (e.g. a googlevideo link signed for this
    /// machine's IP) to disk with progress callbacks.
    pub async fn download_url(
        &self,
        url: &str,
        dest: &Path,
        on_progress: impl FnMut(u64, Option<u64>),
    ) -> Result<u64> {
        let res = self.http.get(url).send().await.context("download request failed")?;
        let status = res.status();
        if !status.is_success() {
            let code = status.as_u16();
            let body = res.text().await.unwrap_or_default();
            return Err(anyhow!("download failed: HTTP {code} {}", body.trim()));
        }
        Ok(Self::stream_to_file(res, dest, on_progress).await?.0)
    }

    /// Shared sink: stream a successful response into `dest` (via a .part
    /// file, renamed on completion) and report (bytes written, total).
    async fn stream_to_file(
        res: reqwest::Response,
        dest: &Path,
        mut on_progress: impl FnMut(u64, Option<u64>),
    ) -> Result<(u64, Option<u64>)> {
        let total = res.content_length();

        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent).await.context("creating cache dir")?;
        }
        let tmp = dest.with_extension("part");
        let mut file = tokio::fs::File::create(&tmp).await.context("creating part file")?;
        let mut written: u64 = 0;
        let mut stream = res.bytes_stream();
        use tokio::io::AsyncWriteExt;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.context("download stream broke")?;
            file.write_all(&chunk).await.context("writing part file")?;
            written += chunk.len() as u64;
            on_progress(written, total);
        }
        file.flush().await?;
        drop(file);
        tokio::fs::rename(&tmp, dest).await.context("committing download")?;
        Ok((written, total))
    }

}
