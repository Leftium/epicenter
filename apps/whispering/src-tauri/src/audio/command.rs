//! Tauri command surface for the audio module.
//!
//! Currently a single endpoint, `encode_upload_audio`, which the TS cloud
//! transcription path calls to compress cpal-recorded WAV before upload.
//! Decode is not exposed: the local transcription engines call the decoder
//! directly from `transcription::run_transcription`.

use log::warn;
use tauri::ipc::{InvokeBody, Request, Response};

use super::encode::encode_wav_to_opus_ogg;

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
