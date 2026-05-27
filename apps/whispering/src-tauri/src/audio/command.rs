//! Tauri command surface for the audio module. One endpoint:
//! `encode_recording_for_upload(recording_id)` reads the durable audio
//! artifact from disk and produces OGG/Opus bytes for cloud upload.
//!
//! Decode is not exposed: the local transcription engines call the
//! decoder directly from `transcription::run_inference` via
//! `read_artifact_samples`.

use log::warn;
use tauri::ipc::Response;
use tauri::AppHandle;

use super::encode::encode_wav_to_opus_ogg;
use crate::recorder::read_artifact_bytes;

/// Compress a saved recording artifact into OGG/Opus for cloud upload.
///
/// The recording is identified by id; Rust resolves the file under the
/// recordings directory (by id prefix, any extension). Symphonia decodes
/// whatever container the source produced (cpal-written WAV, navigator-
/// saved webm/opus/mp4), and libopus re-encodes at the voice bitrate.
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

    tauri::async_runtime::spawn_blocking(move || encode_wav_to_opus_ogg(&bytes))
        .await
        .map_err(|e| format!("background encode task failed: {e}"))?
        .map(Response::new)
        .map_err(|e| {
            warn!("[Audio Encode] failed: {e}");
            e.to_string()
        })
}
