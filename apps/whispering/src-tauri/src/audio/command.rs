//! Tauri command surface for the audio module. One endpoint:
//! `encode_recording_for_upload(recording_id)` resolves the durable audio
//! artifact by id, decodes it to mono 16 kHz PCM (same path the local
//! transcription engines use via `read_artifact_samples`), and re-encodes
//! to OGG/Opus for cloud upload.

use log::warn;
use tauri::ipc::Response;
use tauri::AppHandle;

use super::encode::encode_pcm_to_opus_ogg;
use crate::recorder::read_artifact_samples;

/// Rate `read_artifact_samples` always outputs. Passed through to
/// `encode_pcm_to_opus_ogg` so its source-to-48k resample sees the right
/// input rate.
const ARTIFACT_RATE: u32 = 16_000;

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
    tauri::async_runtime::spawn_blocking(move || {
        let samples = read_artifact_samples(&app_handle, &recording_id)?;
        encode_pcm_to_opus_ogg(samples, ARTIFACT_RATE).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("background encode task failed: {e}"))?
    .map(Response::new)
    .map_err(|e| {
        warn!("[Audio Encode] failed: {e}");
        e
    })
}
