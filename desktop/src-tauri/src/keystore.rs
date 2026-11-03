//! Persistent session storage in the OS credential manager (Windows
//! Credential Manager via the `keyring` crate). The session token is never
//! written to disk, logs, or the webview.

use keyring::Entry;

const SERVICE: &str = "dev.esmeringhoy.desktop";
const USER: &str = "session-token";

fn entry() -> keyring::Result<Entry> {
    Entry::new(SERVICE, USER)
}

pub fn save_token(token: &str) -> Result<(), String> {
    let e = entry().map_err(|e| e.to_string())?;
    e.set_password(token).map_err(|e| e.to_string())
}

pub fn load_token() -> Option<String> {
    entry().ok()?.get_password().ok()
}

pub fn delete_token() -> Result<(), String> {
    let e = entry().map_err(|e| e.to_string())?;
    match e.delete_credential() {
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
