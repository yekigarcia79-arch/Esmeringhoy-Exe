//! Cloudflare Turnstile — what the server expects, not how it is drawn.
//!
//! Turnstile is domain-bound: the widget only issues a token to a page served
//! from a hostname on the site key's list. The interface runs on
//! `http://tauri.localhost`, which no site key can list, so the widget is never
//! rendered in this document. The interface frames `/captcha` from the site
//! instead — a first-party context for Cloudflare — and receives the token
//! over `postMessage`. The CSP names that one origin as the only frame source.
//!
//! Nothing here caches a token. They are single use, and the server is the only
//! place one is verified; a token that never reaches `/api/auth/*` proves
//! nothing at all.

use crate::api::ApiClient;
use serde::Serialize;

#[derive(Clone, Serialize)]
pub struct CaptchaConfig {
    pub required: bool,
    #[serde(rename = "siteKey")]
    pub site_key: String,
}

/// What the server says about the bot check. `/api/auth/config` is public, so
/// this answers before there is a session.
pub async fn config(api: &ApiClient) -> Result<CaptchaConfig, String> {
    let r = api
        .get("/api/auth/config")
        .await
        .map_err(|e| format!("Could not reach the server: {e}"))?;
    if !r.ok() {
        return Err("The server did not answer the verification lookup.".into());
    }
    Ok(CaptchaConfig {
        required: r
            .json
            .get("turnstileRequired")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        site_key: r
            .json
            .get("turnstileSiteKey")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string(),
    })
}
