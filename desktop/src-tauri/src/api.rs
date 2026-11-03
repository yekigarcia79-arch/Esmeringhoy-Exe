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

    /// Download with sequential 1 MiB `Range` requests until a short read or
    /// a 416. Google paces the byte-0-first stream to playback rate (itag
    /// 140 is a 128 kbps stream), but ranged reads from later offsets are
    /// served at full speed — this turns a ~3 minute trickle into ~1-2 s.
    ///
    /// `url_or_path` is either an absolute url (a googlevideo link signed
    /// for this machine's IP) or a backend path (relayed through the
    /// session token; the relay forwards `Range` upstream). No
    /// Content-Length is required: short read (or 416) ends the download.
    pub async fn download_ranged(
        &self,
        url_or_path: &str,
        dest: &Path,
        mut on_progress: impl FnMut(u64, Option<u64>),
    ) -> Result<u64> {
        const CHUNK: u64 = 1 << 20;
        let is_absolute =
            url_or_path.starts_with("http://") || url_or_path.starts_with("https://");
        let url = if is_absolute {
            url_or_path.to_string()
        } else {
            format!("{}/{}", self.base_url, url_or_path.trim_start_matches('/'))
        };

        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent).await.context("creating cache dir")?;
        }
        let tmp = dest.with_extension("part");
        let mut file = tokio::fs::File::create(&tmp).await.context("creating part file")?;
        let mut off: u64 = 0;
        let mut total: Option<u64> = None;
        use tokio::io::AsyncWriteExt;

        loop {
            let range = format!("bytes={off}-{}", off + CHUNK - 1);
            let mut req = self.http.get(&url).header("range", &range);
            if !is_absolute {
                if let Some(t) = self.token() {
                    req = req.bearer_auth(t);
                }
            }
            let res = req.send().await.context("range request failed")?;
            let code = res.status().as_u16();
            if code == 416 {
                break; // offset past EOF — done
            }
            if code != 200 && code != 206 {
                let body = res.text().await.unwrap_or_default();
                return Err(anyhow!("range request failed: HTTP {code} {}", body.trim()));
            }
            let from_200 = code == 200;
            if from_200 && off > 0 {
                return Err(anyhow!("server ignored the Range header mid-download"));
            }
            if let Some(t) = res
                .headers()
                .get("content-range")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.rsplit('/').next().and_then(|x| x.parse::<u64>().ok()))
            {
                total = total.or(Some(t));
            }

            let mut stream = res.bytes_stream();
            let mut wrote: u64 = 0;
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.context("range stream broke")?;
                file.write_all(&chunk).await.context("writing part file")?;
                wrote += chunk.len() as u64;
                on_progress(off + wrote, total);
            }
            if wrote == 0 {
                break;
            }
            off += wrote;
            if from_200 || wrote < CHUNK {
                break; // single-shot response, or last (short) chunk
            }
        }

        file.flush().await?;
        drop(file);
        tokio::fs::rename(&tmp, dest).await.context("committing download")?;
        Ok(off)
    }

}
