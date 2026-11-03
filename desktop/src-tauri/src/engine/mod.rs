//! The playback brain. The server decides *what* plays next; the engine is
//! responsible for bytes → PCM → output device — download, decode, seek,
//! volume, end-of-track.
//!
//! Playback strategy: download the whole track to the local cache (a few
//! MB), decode from the file. Seeking is then a file seek — instant and
//! accurate — and repeat plays are served from disk with no network.

pub mod player;
pub use player::{Engine, PlayingTrack};
