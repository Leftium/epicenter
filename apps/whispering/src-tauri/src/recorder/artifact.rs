//! The audio captured by a recording session.
//!
//! One struct, one shape, no header. The recorder always emits mono PCM
//! at 16 kHz (the consumer worker resamples to that rate before finalize),
//! so the wire format is just the f32 samples back-to-back.
//!
//! IPC: the artifact is serialized as a binary response, not JSON. The
//! `to_binary` method below is the wire-layout source of truth.

/// Captured audio: mono 16 kHz PCM samples.
///
/// `rate` and `channels` are intentionally not stored on this struct. They
/// would be constants in every consumer (16 kHz / 1) and shipping them
/// over the IPC boundary would let a future mismatch silently lie about
/// the data. The recorder's contract is "16 kHz mono f32"; if that ever
/// changes, this struct gains a header and so does `to_binary`.
#[derive(Debug, Clone)]
pub struct CapturedPcm {
    pub samples: Vec<f32>,
}

impl CapturedPcm {
    /// Serialize as a binary IPC body for Tauri's `Response::new`.
    ///
    /// Layout: f32 little-endian samples back to back, no header.
    /// JS reinterprets the bytes as a `Float32Array` view — no JSON, no
    /// decimal round-trip, no extra copy.
    pub fn to_binary(&self) -> Vec<u8> {
        let mut buf = Vec::with_capacity(self.samples.len() * 4);
        for sample in &self.samples {
            buf.extend_from_slice(&sample.to_le_bytes());
        }
        buf
    }
}
