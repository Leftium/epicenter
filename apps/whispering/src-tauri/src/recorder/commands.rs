use crate::recorder::artifact::{AudioArtifact, RecorderMode};
use crate::recorder::recorder::{Recorder, Result};
use log::{debug, info, warn};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

const RECORDER_STATE_CHANGED: &str = "recorder:state-changed";

#[derive(Serialize, Clone, Copy, Debug)]
#[serde(rename_all = "UPPERCASE")]
enum RecordingState {
    Idle,
    Recording,
}

fn emit_recording_state(app: &AppHandle, state: RecordingState) {
    if let Err(e) = app.emit(RECORDER_STATE_CHANGED, state) {
        warn!(
            "Failed to emit {} = {:?}: {}",
            RECORDER_STATE_CHANGED, state, e
        );
    }
}

#[tauri::command]
pub async fn enumerate_recording_devices(
    recorder: State<'_, Mutex<Recorder>>,
) -> Result<Vec<String>> {
    debug!("Enumerating recording devices");
    let recorder = recorder
        .lock()
        .map_err(|e| format!("Failed to lock recorder: {e}"))?;
    recorder.enumerate_devices()
}

#[tauri::command]
pub async fn init_recording_session(
    device_identifier: String,
    recording_id: String,
    output_folder: String,
    sample_rate: Option<u32>,
    mode: RecorderMode,
    recorder: State<'_, Mutex<Recorder>>,
    app_handle: AppHandle,
) -> Result<()> {
    info!(
        "Initializing recording session: device={device_identifier}, id={recording_id}, folder={output_folder}, sample_rate={sample_rate:?}, mode={mode:?}",
    );

    let recordings_dir = PathBuf::from(output_folder);

    if !recordings_dir.exists() {
        std::fs::create_dir_all(&recordings_dir)
            .map_err(|e| format!("Failed to create output folder: {e}"))?;
    }
    if !recordings_dir.is_dir() {
        return Err(format!(
            "Output path is not a directory: {recordings_dir:?}",
        ));
    }

    {
        let mut recorder = recorder
            .lock()
            .map_err(|e| format!("Failed to lock recorder: {e}"))?;
        recorder.init_session(device_identifier, recordings_dir, recording_id, sample_rate, mode)?;
    }
    // init_session calls close_session internally as cleanup. If the previous
    // session was actively recording, that transition is silent at the domain
    // layer; emit IDLE here so the JS state never diverges from reality.
    emit_recording_state(&app_handle, RecordingState::Idle);
    Ok(())
}

#[tauri::command]
pub async fn start_recording(
    recorder: State<'_, Mutex<Recorder>>,
    app_handle: AppHandle,
) -> Result<()> {
    info!("Starting recording");
    {
        let mut recorder = recorder
            .lock()
            .map_err(|e| format!("Failed to lock recorder: {e}"))?;
        recorder.start_recording()?;
    }
    emit_recording_state(&app_handle, RecordingState::Recording);
    Ok(())
}

#[tauri::command]
pub async fn stop_recording(
    recorder: State<'_, Mutex<Recorder>>,
    app_handle: AppHandle,
) -> Result<AudioArtifact> {
    info!("Stopping recording");
    let artifact = {
        let mut recorder = recorder
            .lock()
            .map_err(|e| format!("Failed to lock recorder: {e}"))?;
        recorder.stop_recording()?
    };
    emit_recording_state(&app_handle, RecordingState::Idle);
    Ok(artifact)
}

#[tauri::command]
pub async fn cancel_recording(
    recorder: State<'_, Mutex<Recorder>>,
    app_handle: AppHandle,
) -> Result<()> {
    info!("Cancelling recording");
    {
        let mut recorder = recorder
            .lock()
            .map_err(|e| format!("Failed to lock recorder: {e}"))?;
        recorder.cancel_recording()?;
    }
    emit_recording_state(&app_handle, RecordingState::Idle);
    Ok(())
}

#[tauri::command]
pub async fn close_recording_session(
    recorder: State<'_, Mutex<Recorder>>,
    app_handle: AppHandle,
) -> Result<()> {
    info!("Closing recording session");
    {
        let mut recorder = recorder
            .lock()
            .map_err(|e| format!("Failed to lock recorder: {e}"))?;
        recorder.close_session()?;
    }
    emit_recording_state(&app_handle, RecordingState::Idle);
    Ok(())
}

#[tauri::command]
pub async fn get_current_recording_id(
    recorder: State<'_, Mutex<Recorder>>,
) -> Result<Option<String>> {
    debug!("Getting current recording ID");
    let recorder = recorder
        .lock()
        .map_err(|e| format!("Failed to lock recorder: {e}"))?;
    Ok(recorder.get_current_recording_id())
}
