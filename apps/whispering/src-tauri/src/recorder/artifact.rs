//! Tagged union describing the audio produced by a recording session.
//!
//! The recorder emits exactly one variant per stop:
//! - [`AudioArtifact::Pcm`] for dictation (memory sink, 16 kHz mono).
//! - [`AudioArtifact::File`] for longform (progressive WAV on disk).
//!
//! The discriminant crosses the IPC boundary as JSON via serde's tagged-
//! enum representation. The JS side adds a `kind: 'blob'` variant for
//! navigator output and file-upload paths.

use serde::Serialize;

/// One canonical audio artifact emitted by the recorder.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum AudioArtifact {
    /// In-memory mono PCM. Sample rate is whatever the consumer resampled
    /// to (16 kHz for dictation). `channels` is always 1 today but is
    /// plumbed so a future stereo mode is non-breaking.
    #[serde(rename = "pcm")]
    Pcm {
        samples: Vec<f32>,
        rate: u32,
        channels: u16,
        duration_seconds: f32,
    },

    /// Audio is persisted on disk; the IPC payload is the path. Native
    /// rate is preserved so a future re-transcription with a better
    /// engine sees the original capture.
    #[serde(rename = "file")]
    File {
        path: String,
        rate: u32,
        channels: u16,
        duration_seconds: f32,
        container: AudioContainer,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AudioContainer {
    Wav,
}

/// Storage and processing policy, selected per `init_session` call.
///
/// `RecorderMode` carries every policy axis (sink type, resampling,
/// short-clip padding) by itself. The variants are not orthogonal:
/// dictation always means "memory sink + resample to 16 kHz + pad short
/// clips"; longform always means "WAV on disk + native rate + no pad."
/// If a future requirement needs an axis to vary independently, split
/// this enum then.
#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecorderMode {
    Dictation,
    Longform,
}
