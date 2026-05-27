//! Tauri command surface for the audio module. One endpoint:
//! `encode_recording_for_upload(recording_id)` reads the durable audio
//! artifact from disk, decodes via Symphonia (so the same path works for
//! cpal-written WAV and navigator-saved webm/opus/mp4), and produces
//! OGG/Opus bytes for cloud upload.
//!
//! Decode is not separately exposed to JS: the local transcription
//! engines call the decoder through `read_artifact_samples` from
//! `transcription::transcribe_recording`.

use log::warn;
use tauri::ipc::Response;
use tauri::AppHandle;

use super::decode::decode_to_pcm16k_mono;
use super::encode::encode_pcm_to_opus_ogg;
use crate::recorder::read_artifact_bytes;

/// Sample rate `decode_to_pcm16k_mono` always outputs. Pass through to
/// `encode_pcm_to_opus_ogg` so the encoder's source-to-48k resample sees
/// the right input rate.
const DECODE_RATE: u32 = 16_000;

/// Compress a saved recording artifact into OGG/Opus for cloud upload.
///
/// JS call shape:
/// ```js
/// const compressed = await invoke('encode_recording_for_upload', {
///   recordingId,
/// });
/// ```
#[tauri::command]
pub async fn encode_recording_for_upload(
    recording_id: String,
    app_handle: AppHandle,
) -> Result<Response, String> {
    let bytes = read_artifact_bytes(&app_handle, &recording_id)?;

    tauri::async_runtime::spawn_blocking(move || {
        let samples = decode_to_pcm16k_mono(&bytes).map_err(|e| e.to_string())?;
        encode_pcm_to_opus_ogg(&samples, DECODE_RATE, 1).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("background encode task failed: {e}"))?
    .map(Response::new)
    .map_err(|e| {
        warn!("[Audio Encode] failed: {e}");
        e
    })
}
