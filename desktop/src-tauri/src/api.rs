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

    pub async fn get(&self, path: &str) -> Result<ApiResponse> {
        self.call("GET", path, None).await
    }

    pub async fn thumb_data_url(&self, name: &str) -> Result<String> {
        if let Ok(url) = self.backend_thumb(name).await {
            return Ok(url);
        }
        let art = self.deezer_artist_art(name).await?;
        self.image_data_url(&art).await
    }

    async fn backend_thumb(&self, name: &str) -> Result<String> {
        let url = format!("{}/api/thumb?name={}", self.base_url, encode_query(name));
        let mut req = self.http.get(&url);
        if let Some(t) = self.token() {
            req = req.bearer_auth(t);
        }
        let res = req.send().await.context("thumb request failed")?;
        if !res.status().is_success() {
            return Err(anyhow!("thumb HTTP {}", res.status()));
        }
        let mime = res
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .filter(|v| v.starts_with("image/"))
            .unwrap_or("image/jpeg")
            .to_string();
        let bytes = res.bytes().await.context("reading thumb")?;
        if bytes.is_empty() {
            return Err(anyhow!("empty thumb"));
        }
        Ok(format!("data:{};base64,{}", mime, base64(&bytes)))
    }

    async fn deezer_artist_art(&self, name: &str) -> Result<String> {
        let url = format!(
            "https://api.deezer.com/search/artist?q={}&limit=1",
            encode_query(name)
        );
        let res = self.http.get(&url).send().await.context("deezer request failed")?;
        if !res.status().is_success() {
            return Err(anyhow!("deezer HTTP {}", res.status()));
        }
        let json: Value = res.json().await.context("deezer json")?;
        let hit = json.get("data").and_then(|d| d.get(0));
        let found = hit
            .and_then(|a| a.get("name"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if !same_artist(found, name) {
            return Err(anyhow!("no deezer match for {name}"));
        }
        let art = hit
            .and_then(|a| a.get("picture_medium"))
            .or_else(|| hit.and_then(|a| a.get("picture_big")))
            .or_else(|| hit.and_then(|a| a.get("picture")))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if art.is_empty() {
            return Err(anyhow!("deezer has no picture for {name}"));
        }
        Ok(art.replace("/250x250-", "/500x500-"))
    }

    async fn image_data_url(&self, url: &str) -> Result<String> {
        let res = self.http.get(url).send().await.context("image request failed")?;
        if !res.status().is_success() {
            return Err(anyhow!("image HTTP {}", res.status()));
        }
        let mime = res
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .filter(|v| v.starts_with("image/"))
            .unwrap_or("image/jpeg")
            .to_string();
        let bytes = res.bytes().await.context("reading image")?;
        if bytes.is_empty() {
            return Err(anyhow!("empty image"));
        }
        Ok(format!("data:{};base64,{}", mime, base64(&bytes)))
    }

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
                break;
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
                file.flush().await.context("flushing part file")?;
                wrote += chunk.len() as u64;
                on_progress(off + wrote, total);
            }
            if wrote == 0 {
                break;
            }
            off += wrote;
            if from_200 || wrote < CHUNK {
                break;
            }
        }

        file.flush().await?;
        drop(file);
        tokio::fs::rename(&tmp, dest).await.context("committing download")?;
        Ok(off)
    }

}

fn encode_query(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn base64(bytes: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let n = ((chunk[0] as u32) << 16)
            | ((*chunk.get(1).unwrap_or(&0) as u32) << 8)
            | (*chunk.get(2).unwrap_or(&0) as u32);
        out.push(A[(n >> 18) as usize & 63] as char);
        out.push(A[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { A[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { A[n as usize & 63] as char } else { '=' });
    }
    out
}

fn same_artist(a: &str, b: &str) -> bool {
    fn norm(s: &str) -> String {
        s.chars()
            .filter(|c| c.is_alphanumeric())
            .flat_map(|c| c.to_lowercase())
            .collect()
    }
    let (x, y) = (norm(a), norm(b));
    !x.is_empty() && x == y
}
