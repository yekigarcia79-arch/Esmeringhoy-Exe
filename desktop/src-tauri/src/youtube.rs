use anyhow::{anyhow, Context, Result};
use reqwest::Client;
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::Duration;

const UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const ITAG_AAC: [u64; 2] = [140, 139];

#[derive(Clone, Debug)]
pub struct Resolved {
    pub url: String,
    #[allow(dead_code)]
    pub itag: u32,
    #[allow(dead_code)]
    pub duration_secs: f64,
}

static VISITOR: Mutex<Option<String>> = Mutex::new(None);

fn context(name: &str, version: &str, gl: &str, visitor: Option<&str>) -> Value {
    let mut client = json!({
        "clientName": name,
        "clientVersion": version,
        "hl": "en",
        "gl": gl,
    });
    if let Some(vd) = visitor {
        client["visitorData"] = json!(vd);
    }
    json!({ "client": client })
}

async fn api(path: &str, body: &Value, client_name: u64, client_version: &str, extra: Vec<(&str, &str)>) -> Result<Value> {
    let http = Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent(UA)
        .build()
        .context("building http client")?;
    let url = format!("https://music.youtube.com/youtubei/v1/{path}?prettyPrint=false");
    let mut req = http
        .post(&url)
        .header("content-type", "application/json")
        .header("x-youtube-client-name", client_name.to_string())
        .header("x-youtube-client-version", client_version)
        .json(body);
    for (k, v) in extra {
        req = req.header(k, v);
    }
    let res = req.send().await.with_context(|| format!("InnerTube {path} -> request failed"))?;
    if !res.status().is_success() {
        anyhow::bail!("InnerTube {path} -> HTTP {}", res.status());
    }
    res.json().await.with_context(|| format!("InnerTube {path} -> bad JSON"))
}

fn first_string(node: &Value, key: &str) -> Option<String> {
    match node {
        Value::Object(map) => {
            if let Some(Value::String(s)) = map.get(key) {
                return Some(s.clone());
            }
            map.values().find_map(|v| first_string(v, key))
        }
        Value::Array(arr) => arr.iter().find_map(|v| first_string(v, key)),
        _ => None,
    }
}

async fn visitor_data() -> Result<String> {
    if let Some(vd) = VISITOR.lock().unwrap().as_ref() {
        return Ok(vd.clone());
    }
    let body = json!({
        "context": context("WEB_REMIX", "1.20241120.01.00", "US", None),
        "query": "music",
    });
    let data = api("search", &body, 67, "1.20241120.01.00", vec![]).await?;
    let vd = first_string(&data, "visitorData").context("visitorData missing from WEB_REMIX response")?;
    *VISITOR.lock().unwrap() = Some(vd.clone());
    Ok(vd)
}

fn pick_format(adaptive: Option<&Value>, duration_secs: f64) -> Option<Resolved> {
    let formats = adaptive?.as_array()?;
    for itag in ITAG_AAC {
        let url = formats.iter().find_map(|f| {
            if f.get("itag").and_then(Value::as_u64) == Some(itag) {
                f.get("url").and_then(Value::as_str).filter(|u| !u.is_empty()).map(str::to_string)
            } else {
                None
            }
        });
        if let Some(url) = url {
            return Some(Resolved { url, itag: itag as u32, duration_secs });
        }
    }
    None
}

pub async fn resolve(video_id: &str) -> Result<Resolved> {
    let vd = visitor_data().await?;
    let body = json!({
        "context": context("VISIONOS", "1.02.00", "US", Some(&vd)),
        "videoId": video_id,
        "contentCheckOk": true,
        "racyCheckOk": true,
    });
    let data = api("player", &body, 101, "1.02.00", vec![("x-goog-visitor-id", vd.as_str())]).await?;

    let status = data.pointer("/playabilityStatus/status").and_then(Value::as_str).unwrap_or("UNKNOWN");
    if status != "OK" {
        let reason = data
            .pointer("/playabilityStatus/reason")
            .and_then(Value::as_str)
            .unwrap_or("");
        anyhow::bail!(
            "YouTube refused playback (playabilityStatus={status}{})",
            if reason.is_empty() { String::new() } else { format!(" — {reason}") }
        );
    }

    let duration_secs = data
        .pointer("/videoDetails/lengthSeconds")
        .and_then(Value::as_str)
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0);

    pick_format(data.pointer("/streamingData/adaptiveFormats"), duration_secs)
        .ok_or_else(|| anyhow!("no AAC stream (itag 140/139) in the player response"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn first_string_walks_nested_documents() {
        let doc = json!({
            "a": { "b": [ { "visitorData": "TOKEN123" } ] },
            "c": "not-it",
        });
        assert_eq!(first_string(&doc, "visitorData").as_deref(), Some("TOKEN123"));
        assert_eq!(first_string(&json!({"x": [1, null, {}]}), "nope"), None);
    }

    #[test]
    fn pick_format_prefers_140_then_139() {
        let formats = json!([
            { "itag": 251, "url": "https://a/opus" },
            { "itag": 139, "url": "https://a/aac139" },
            { "itag": 140, "url": "https://a/aac140" },
        ]);
        let got = pick_format(Some(&formats), 200.0).unwrap();
        assert_eq!(got.itag, 140);
        assert_eq!(got.duration_secs, 200.0);

        let only_139 = json!([
            { "itag": 251, "url": "https://a/opus" },
            { "itag": 139, "url": "https://a/aac139" },
        ]);
        let got = pick_format(Some(&only_139), 100.0).unwrap();
        assert_eq!(got.itag, 139);

        let no_url = json!([{ "itag": 140 }]);
        assert!(pick_format(Some(&no_url), 1.0).is_none());

        let none_ok = json!([{ "itag": 251, "url": "https://a/opus" }]);
        assert!(pick_format(Some(&none_ok), 1.0).is_none());
    }

    #[test]
    #[ignore]
    fn live_resolve() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let res = rt.block_on(super::resolve("XVveECQmiAk")).expect("resolve failed");
        println!("itag={} duration={}s url={}…", res.itag, res.duration_secs, &res.url[..60.min(res.url.len())]);
        assert!(res.url.starts_with("https://"));
        assert!(res.duration_secs > 60.0);
        assert!(res.itag == 140 || res.itag == 139);
    }

    #[test]
    #[ignore]
    fn live_download() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let res = super::resolve("XVveECQmiAk").await.expect("resolve failed");
            let client = crate::api::ApiClient::new("http://127.0.0.1:1");
            let dest = std::env::temp_dir().join(format!("esm-live-{}.m4a", std::process::id()));
            let t0 = std::time::Instant::now();
            let bytes = client
                .download_ranged(&res.url, &dest, |_, _| {}, None)
                .await
                .expect("download failed");
            println!("downloaded {bytes} bytes in {:?}", t0.elapsed());
            assert_eq!(bytes, 2_877_457);
            assert!(dest.is_file());
            let _ = std::fs::remove_file(&dest);
        });
    }
}
