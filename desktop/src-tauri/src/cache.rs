use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Default, Serialize, Deserialize)]
struct CacheIndex {
    entries: HashMap<String, CacheEntry>,
}

#[derive(Clone, Serialize, Deserialize)]
struct CacheEntry {
    bytes: u64,
    last_used: u64,
    ext: String,
    #[serde(default)]
    seq: u64,
}

pub struct TrackCache {
    root: PathBuf,
    max_bytes: AtomicU64,
    inner: Mutex<CacheIndex>,
    seq: AtomicU64,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn next_seq_hint(idx: &CacheIndex) -> u64 {
    idx.entries.values().map(|e| e.seq).max().unwrap_or(0) + 1
}

impl TrackCache {
    pub fn new(root: PathBuf, max_bytes: u64) -> Self {
        let _ = std::fs::create_dir_all(&root);
        let index_path = root.join("index.json");
        let index = std::fs::read_to_string(&index_path)
            .ok()
            .and_then(|s| serde_json::from_str::<CacheIndex>(&s).ok())
            .unwrap_or_default();
        let seq0 = next_seq_hint(&index);
        let cache = Self {
            root,
            max_bytes: AtomicU64::new(max_bytes),
            inner: Mutex::new(index),
            seq: AtomicU64::new(seq0),
        };
        cache.sweep_orphans();
        cache
    }

    pub fn total_bytes(&self) -> u64 {
        self.inner.lock().unwrap().entries.values().map(|e| e.bytes).sum()
    }

    pub fn stats(&self) -> (u64, usize) {
        let idx = self.inner.lock().unwrap();
        (idx.entries.values().map(|e| e.bytes).sum(), idx.entries.len())
    }

    pub fn cap(&self) -> u64 {
        self.max_bytes.load(Ordering::Relaxed)
    }

    pub fn set_cap(&self, bytes: u64) {
        self.max_bytes.store(bytes.max(1), Ordering::Relaxed);
        self.evict_to_cap();
        self.persist();
    }

    pub fn remove(&self, video_id: &str) {
        let ext = {
            let mut idx = self.inner.lock().unwrap();
            idx.entries.remove(video_id).map(|e| e.ext)
        };
        if let Some(ext) = ext {
            let _ = std::fs::remove_file(self.root.join(format!("{video_id}.{ext}")));
            self.persist();
        }
    }

    pub fn path_for(&self, video_id: &str, ext: &str) -> PathBuf {
        self.root.join(format!("{video_id}.{ext}"))
    }

    pub fn lookup(&self, video_id: &str) -> Option<PathBuf> {
        let mut idx = self.inner.lock().unwrap();
        let mut ext = None;
        if let Some(e) = idx.entries.get(video_id) {
            let p = self.root.join(format!("{video_id}.{}", e.ext));
            if p.is_file() {
                ext = Some((p, e.ext.clone()));
            }
        }
        let (path, ext) = ext?;
        let next = self.seq.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        idx.entries.get_mut(video_id).unwrap().last_used = now_secs();
        idx.entries.get_mut(video_id).unwrap().seq = next;
        drop(idx);
        let _ = ext;
        self.persist();
        Some(path)
    }

    pub fn record(&self, video_id: &str, ext: &str, bytes: u64) {
        {
            let next = self.seq.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
            let mut idx = self.inner.lock().unwrap();
            idx.entries.insert(
                video_id.to_string(),
                CacheEntry { bytes, last_used: now_secs(), ext: ext.to_string(), seq: next },
            );
        }
        self.evict_to_cap();
        self.persist();
    }

    pub fn clear_all(&self) -> Result<u64> {
        let entries: Vec<(String, CacheEntry)> = {
            let idx = self.inner.lock().unwrap();
            idx.entries.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
        };
        let mut freed = 0u64;
        let mut kept: Vec<String> = Vec::new();
        for (id, entry) in entries {
            let path = self.root.join(format!("{id}.{}", entry.ext));
            match std::fs::remove_file(&path) {
                Ok(()) => freed += entry.bytes,
                Err(_) if path.is_file() => kept.push(id),
                Err(_) => {}
            }
        }
        {
            let mut idx = self.inner.lock().unwrap();
            idx.entries.retain(|id, _| kept.iter().any(|k| k == id));
        }
        self.persist();
        Ok(freed)
    }

    fn evict_to_cap(&self) {
        loop {
            let (bytes, oldest) = {
                let idx = self.inner.lock().unwrap();
                let bytes: u64 = idx.entries.values().map(|e| e.bytes).sum();
                let oldest = idx
                    .entries
                    .iter()
                    .min_by_key(|(_, e)| (e.last_used, e.seq))
                    .map(|(k, e)| (k.clone(), e.ext.clone(), e.bytes));
                (bytes, oldest)
            };
            if bytes <= self.max_bytes.load(Ordering::Relaxed) {
                break;
            }
            let Some((video_id, ext, size)) = oldest else { break };
            let _ = std::fs::remove_file(self.root.join(format!("{video_id}.{ext}")));
            let mut idx = self.inner.lock().unwrap();
            idx.entries.remove(&video_id);
            drop(idx);
            let _ = size;
            self.persist();
        }
    }

    fn sweep_orphans(&self) {
        if let Ok(rd) = std::fs::read_dir(&self.root) {
            for e in rd.flatten() {
                let p = e.path();
                if p.extension().and_then(|x| x.to_str()) == Some("part") {
                    let _ = std::fs::remove_file(&p);
                }
            }
        }
        let mut changed = false;
        {
            let mut idx = self.inner.lock().unwrap();
            idx.entries.retain(|id, e| {
                let ok = self.root.join(format!("{id}.{}", e.ext)).is_file();
                if !ok {
                    changed = true;
                }
                ok
            });
        }
        if changed {
            self.persist();
        }
    }

    fn persist(&self) {
        let idx = self.inner.lock().unwrap();
        if let Ok(s) = serde_json::to_string(&*idx) {
            let path = self.root.join("index.json");
            let tmp = path.with_extension("tmp");
            if std::fs::write(&tmp, s).is_ok() {
                let _ = std::fs::rename(&tmp, &path);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("esm-cache-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        let _ = std::fs::create_dir_all(&p);
        p
    }

    #[test]
    fn lookup_and_evict() {
        let dir = tmp();
        let cache = TrackCache::new(dir.clone(), 10);
        let f = cache.path_for("aaa", "m4a");
        std::fs::write(&f, b"12345678").unwrap();
        cache.record("aaa", "m4a", 8);
        assert!(cache.lookup("aaa").is_some());

        let f = cache.path_for("bbb", "m4a");
        std::fs::write(&f, b"12345678").unwrap();
        cache.record("bbb", "m4a", 8);
        assert!(!dir.join("aaa.m4a").is_file());
        assert_eq!(cache.total_bytes(), 8);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
