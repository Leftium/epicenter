mod config;
mod error;
mod events;
mod model_manager;

use crate::recorder::read_artifact_samples;
pub use config::TranscriptionConfig;
pub use error::TranscriptionError;
pub use events::LocalModelState;
pub use model_manager::ModelManager;
use tauri::{AppHandle, State};

/// Push the ambient transcription configuration. Replaces the per-call
/// `config` argument that `transcribe_recording` used to take. The FE
/// invokes this once at startup and on every subsequent change to
/// settings, model selection, language, prompt, or unload policy.
///
/// Drift in `(engine, modelPath)` triggers a background preload so the
/// next `transcribe_recording` call does not pay cold-start latency.
/// Other field changes take effect on the next transcription with no
/// reload.
#[tauri::command]
#[specta::specta]
pub fn set_transcription_config(
    config: TranscriptionConfig,
    model_manager: State<'_, ModelManager>,
) {
    model_manager.set_transcription_config(config);
}

/// Snapshot the current model state. Used by late-mounted observers (a
/// second window, the settings panel re-opening, etc.) to catch up to
/// the current lifecycle state without waiting for the next event on
/// `transcription://model-state`.
///
/// Reads a lock-free status field plus the ambient config; never touches
/// the cache mutex, so it returns immediately even mid-inference.
#[tauri::command]
#[specta::specta]
pub fn get_transcription_state(model_manager: State<'_, ModelManager>) -> LocalModelState {
    model_manager.snapshot()
}

/// Canonical transcribe-by-id path. Resolves the audio file under
/// `<appDataDir>/recordings/{recordingId}.*` (cpal-written WAV,
/// navigator-saved webm/opus/mp4, etc.), decodes, runs inference using
/// the ambient configuration pushed via `set_transcription_config`.
///
/// Returns `NoConfig` if the FE has not pushed a config yet.
#[tauri::command]
#[specta::specta]
pub async fn transcribe_recording(
    recording_id: String,
    app_handle: AppHandle,
    model_manager: State<'_, ModelManager>,
) -> Result<String, TranscriptionError> {
    let samples = read_artifact_samples(&app_handle, &recording_id)
        .map_err(|e| TranscriptionError::AudioReadError { message: e })?;

    let manager = model_manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.transcribe(samples))
        .await
        .map_err(join_err)?
}

/// Map a join failure from spawn_blocking into a TranscriptionError so the
/// frontend always sees a structured error even when the background task
/// panics or is cancelled.
fn join_err(e: tauri::Error) -> TranscriptionError {
    TranscriptionError::TranscriptionError {
        message: format!("Background transcription task failed: {}", e),
    }
}
