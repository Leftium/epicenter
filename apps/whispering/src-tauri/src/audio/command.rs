//! Tauri command surface for the audio module.
//!
//! Two endpoints today: `encode_upload_audio` compresses an in-memory WAV
//! (longform file artifact, file uploads), and `encode_upload_pcm`
//! compresses a raw mono f32 PCM buffer (dictation memory artifact). Both
//! produce OGG/Opus at the libopus voice bitrate.
//!
//! Decode is not exposed: the local transcription engines call the
//! decoder directly from `transcription::run_transcription`.

use log::warn;
use tauri::ipc::{InvokeBody, Request, Response};

use super::encode::{encode_pcm_to_opus_ogg, encode_wav_to_opus_ogg};

/// Compress a WAV audio blob into OGG/Opus for cloud transcription upload.
///
/// Audio bytes arrive as the raw IPC body. The output bitrate is fixed at
/// the encoder's default (24 kbps voice VBR); when a user-tunable bitrate
/// lands, plumb it through here as a header.
///
/// JS call shape:
/// ```js
/// const compressed = await invoke('encode_upload_audio', wavArrayBuffer);
/// ```
#[tauri::command]
pub async fn encode_upload_audio(request: Request<'_>) -> Result<Response, String> {
    let wav_bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        InvokeBody::Json(_) => {
            return Err(
                "Audio must be sent as the raw IPC body, not JSON".to_string(),
            );
        }
    };

    tauri::async_runtime::spawn_blocking(move || encode_wav_to_opus_ogg(&wav_bytes))
        .await
        .map_err(|e| format!("background encode task failed: {e}"))?
        .map(Response::new)
        .map_err(|e| {
            warn!("[Audio Encode] failed: {e}");
            e.to_string()
        })
}

/// Compress an in-memory PCM buffer into OGG/Opus for cloud transcription
/// upload. Used by the dictation cpal path: the recorder produces a mono
/// f32 buffer in memory, we hand it straight to libopus without any WAV
/// round-trip.
///
/// Body layout (little-endian):
/// ```text
///   bytes 0..4    : u32   sample_rate
///   bytes 4..6    : u16   channels
///   bytes 6..8    : u16   reserved (pad)
///   bytes 8..     : f32[] interleaved samples
/// ```
///
/// JS call shape:
/// ```js
/// const buf = packPcm(rate, channels, samples);
/// const compressed = await invoke('encode_upload_pcm', buf);
/// ```
#[tauri::command]
pub async fn encode_upload_pcm(request: Request<'_>) -> Result<Response, String> {
    let body = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        InvokeBody::Json(_) => {
            return Err(
                "PCM must be sent as the raw IPC body, not JSON".to_string(),
            );
        }
    };

    if body.len() < 8 {
        return Err(format!(
            "PCM body too short: expected at least 8 header bytes, got {}",
            body.len()
        ));
    }

    let rate = u32::from_le_bytes([body[0], body[1], body[2], body[3]]);
    let channels = u16::from_le_bytes([body[4], body[5]]);
    let samples_bytes = &body[8..];
    if samples_bytes.len() % 4 != 0 {
        return Err(format!(
            "PCM sample bytes not a multiple of 4 (f32 size): got {} trailing bytes",
            samples_bytes.len()
        ));
    }

    let samples: Vec<f32> = samples_bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();

    tauri::async_runtime::spawn_blocking(move || {
        encode_pcm_to_opus_ogg(&samples, rate, channels)
    })
    .await
    .map_err(|e| format!("background encode task failed: {e}"))?
    .map(Response::new)
    .map_err(|e| {
        warn!("[Audio Encode] failed: {e}");
        e.to_string()
    })
}
