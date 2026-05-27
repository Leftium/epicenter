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

/// The sample rate at which the cpal recorder emits captured PCM. The
/// Rust recorder resamples every device to this rate before finalize, so
/// every `encode_upload_pcm` payload arrives at this rate.
const RECORDER_OUTPUT_RATE: u32 = 16_000;

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
/// 16 kHz f32 buffer in memory, we hand it straight to libopus without any
/// WAV round-trip.
///
/// Body layout: raw little-endian f32 samples back to back, no header.
/// The recorder's contract is "16 kHz mono"; this handler hardcodes those
/// values when calling the general-purpose encoder. If the contract ever
/// changes, both sides grow a header together.
///
/// JS call shape:
/// ```js
/// const compressed = await invoke('encode_upload_pcm', samples.buffer);
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

    if body.len() % 4 != 0 {
        return Err(format!(
            "PCM byte length not a multiple of 4 (f32 size): got {} bytes",
            body.len()
        ));
    }

    let samples: Vec<f32> = body
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();

    tauri::async_runtime::spawn_blocking(move || {
        encode_pcm_to_opus_ogg(&samples, RECORDER_OUTPUT_RATE, 1)
    })
    .await
    .map_err(|e| format!("background encode task failed: {e}"))?
    .map(Response::new)
    .map_err(|e| {
        warn!("[Audio Encode] failed: {e}");
        e.to_string()
    })
}
