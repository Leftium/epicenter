use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Failure modes for the audio decode/encode pipeline.
///
/// Serialized with a `name` tag so the TypeScript side can discriminate on
/// the variant. Surface text is short and structured: the caller adds the
/// user-facing wrapper.
#[derive(Error, Debug, Serialize, Deserialize)]
#[serde(tag = "name")]
pub enum AudioError {
    #[error("Audio decode failed: {message}")]
    DecodeFailed { message: String },

    #[error("Unsupported audio format: {message}")]
    UnsupportedFormat { message: String },

    #[error("Audio resample failed: {message}")]
    ResampleFailed { message: String },
}

impl AudioError {
    pub(crate) fn decode(msg: impl Into<String>) -> Self {
        AudioError::DecodeFailed { message: msg.into() }
    }

    pub(crate) fn unsupported(msg: impl Into<String>) -> Self {
        AudioError::UnsupportedFormat { message: msg.into() }
    }

    pub(crate) fn resample(msg: impl Into<String>) -> Self {
        AudioError::ResampleFailed { message: msg.into() }
    }
}
