//! Play while downloading.
//!
//! The engine used to wait for the whole file before it made a sound. Now the
//! downloader writes a `.part` file that grows, a decoder thread reads it
//! through [`TailFile`] — blocking there is fine, it is not the audio thread —
//! and [`RingSource`] hands samples to rodio. The callback never touches the
//! network or the disk, so a slow moment is a moment of silence, not a dead
//! output device.

use rodio::Source;
use std::collections::VecDeque;
use std::num::NonZeroU16;
use std::num::NonZeroU32;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// How many bytes must be on disk before the decoder is allowed to open the
/// file: the ftyp/moov/sidx header plus a couple of fragments — about twenty
/// seconds of audio, which is far more than the download needs to catch up.
pub const PREBUFFER_BYTES: u64 = 400 * 1024;

/// Shared between the writer and the reader: how far the file has grown,
/// whether the writer is finished, and why it stopped if it failed.
pub struct Tail {
    avail: AtomicU64,
    done: AtomicBool,
    error: Mutex<Option<String>>,
}

impl Tail {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            avail: AtomicU64::new(0),
            done: AtomicBool::new(false),
            error: Mutex::new(None),
        })
    }

    pub fn advance(&self, bytes: u64) {
        self.avail.store(bytes, Ordering::SeqCst);
    }

    pub fn finish(&self) {
        self.done.store(true, Ordering::SeqCst);
    }

    pub fn fail(&self, message: impl Into<String>) {
        *self.error.lock().unwrap() = Some(message.into());
        self.finish();
    }

    pub fn available(&self) -> u64 {
        self.avail.load(Ordering::SeqCst)
    }

    pub fn is_done(&self) -> bool {
        self.done.load(Ordering::SeqCst)
    }

    /// Why the writer stopped, when it stopped badly.
    pub fn error(&self) -> Option<String> {
        self.error.lock().unwrap().clone()
    }

}

/// The growing file, seen by the decoder. Reads past the written end block
/// until more arrives — this only ever runs on the decoder thread.
pub struct TailFile {
    file: File,
    pos: u64,
    tail: Arc<Tail>,
}

impl TailFile {
    pub fn open(path: &Path, tail: Arc<Tail>) -> std::io::Result<Self> {
        Ok(Self { file: File::open(path)?, pos: 0, tail })
    }
}

impl Read for TailFile {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        loop {
            let avail = self.tail.available();
            if self.pos < avail {
                let want = ((avail - self.pos) as usize).min(buf.len());
                self.file.seek(SeekFrom::Start(self.pos))?;
                let n = self.file.read(&mut buf[..want])?;
                if n == 0 {
                    return Ok(0);
                }
                self.pos += n as u64;
                return Ok(n);
            }
            if self.tail.is_done() {
                if let Some(e) = self.tail.error() {
                    return Err(std::io::Error::new(std::io::ErrorKind::Other, e));
                }
                return Ok(0);
            }
            std::thread::sleep(Duration::from_millis(15));
        }
    }
}

impl Seek for TailFile {
    fn seek(&mut self, from: SeekFrom) -> std::io::Result<u64> {
        let target = match from {
            SeekFrom::Start(n) => n as i64,
            SeekFrom::Current(n) => self.pos as i64 + n,
            // The length is not known until the writer is done; the MP4 header
            // is at the front, so nothing legitimately asks for the end.
            SeekFrom::End(_) => {
                return Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "still streaming"))
            }
        };
        if target < 0 {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "negative seek"));
        }
        self.pos = target as u64;
        Ok(self.pos)
    }
}

/// Samples decoded but not yet played, plus the state the audio callback needs
/// to keep going. Bounded so a fast download cannot eat memory.
pub struct Ring {
    buf: Mutex<VecDeque<f32>>,
    cap: usize,
    done: AtomicBool,
    channels: NonZeroU16,
    rate: NonZeroU32,
}

impl Ring {
    pub fn new(channels: NonZeroU16, rate: NonZeroU32) -> Arc<Self> {
        let cap = rate.get() as usize * channels.get() as usize * 20; // twenty seconds
        Arc::new(Self {
            buf: Mutex::new(VecDeque::with_capacity(cap.min(1 << 20))),
            cap,
            done: AtomicBool::new(false),
            channels,
            rate,
        })
    }

    fn push(&self, sample: f32) {
        self.buf.lock().unwrap().push_back(sample);
    }

    fn take(&self) -> Option<f32> {
        self.buf.lock().unwrap().pop_front()
    }

    fn is_full(&self) -> bool {
        self.buf.lock().unwrap().len() >= self.cap
    }

    pub fn finish(&self) {
        self.done.store(true, Ordering::SeqCst);
    }

    pub fn is_done(&self) -> bool {
        self.done.load(Ordering::SeqCst)
    }
}

/// What rodio pulls from. Starvation yields silence (the device stays alive)
/// and only a finished decoder yields `None`.
pub struct RingSource {
    ring: Arc<Ring>,
}

impl RingSource {
    pub fn new(ring: Arc<Ring>) -> Self {
        Self { ring }
    }
}

impl Iterator for RingSource {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        if let Some(sample) = self.ring.take() {
            return Some(sample);
        }
        if self.ring.is_done() {
            return None;
        }
        Some(0.0)
    }
}

impl Source for RingSource {
    fn current_span_len(&self) -> Option<usize> {
        None
    }

    fn channels(&self) -> NonZeroU16 {
        self.ring.channels
    }

    fn sample_rate(&self) -> NonZeroU32 {
        self.ring.rate
    }

    fn total_duration(&self) -> Option<Duration> {
        None
    }
}

/// Decode on a thread of its own so the audio callback never blocks on the
/// network. `cancel` is set when another track takes over.
pub fn spawn_decoder<R>(mut decoder: rodio::Decoder<R>, ring: Arc<Ring>, cancel: Arc<AtomicBool>)
where
    R: Read + Seek + Send + Sync + 'static,
{
    let _ = std::thread::Builder::new()
        .name("esm-decode".into())
        .spawn(move || {
            loop {
                if cancel.load(Ordering::SeqCst) {
                    return;
                }
                match decoder.next() {
                    Some(sample) => {
                        while ring.is_full() {
                            if cancel.load(Ordering::SeqCst) {
                                return;
                            }
                            std::thread::sleep(Duration::from_millis(15));
                        }
                        ring.push(sample);
                    }
                    None => break,
                }
            }
            ring.finish();
        });
}
