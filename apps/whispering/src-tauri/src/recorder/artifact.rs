//! The audio captured by a recording session.
//!
//! One struct, one shape. The recorder always emits mono PCM at 16 kHz
//! (it resamples to that rate inside the consumer worker), so there's
//! no need for a tagged union here.
//!
//! IPC: the artifact is serialized as a binary response, not JSON. The
//! `to_binary` method below is the wire-layout source of truth.

/// Captured audio: mono PCM samples plus metadata.
#[derive(Debug, Clone)]
pub struct AudioArtifact {
    pub samples: Vec<f32>,
    pub rate: u32,
    pub channels: u16,
}

impl AudioArtifact {
    /// Serialize as a binary IPC body for Tauri's `Response::new`.
    ///
    /// Layout (little-endian):
    /// ```text
    ///   bytes 0..4   : u32  rate
    ///   bytes 4..6   : u16  channels
    ///   bytes 6..8   : u16  padding (aligns samples to f32 boundary)
    ///   bytes 8..    : f32[] samples
    /// ```
    /// JS reinterprets the trailing bytes as a `Float32Array` view, no
    /// JSON, no decimal round-trip, no extra copy.
    pub fn to_binary(&self) -> Vec<u8> {
        let header_size = 8;
        let mut buf = Vec::with_capacity(header_size + self.samples.len() * 4);
        buf.extend_from_slice(&self.rate.to_le_bytes());
        buf.extend_from_slice(&self.channels.to_le_bytes());
        buf.extend_from_slice(&0u16.to_le_bytes());
        for sample in &self.samples {
            buf.extend_from_slice(&sample.to_le_bytes());
        }
        buf
    }
}
