use crate::recorder::recorder::{Recorder, Result};
use log::{debug, info, warn};
use serde::Serialize;
use std::sync::Mutex;
use tauri::ipc::Response;
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
    sample_rate: Option<u32>,
    recorder: State<'_, Mutex<Recorder>>,
    app_handle: AppHandle,
) -> Result<()> {
    info!(
        "Initializing recording session: device={device_identifier}, id={recording_id}, sample_rate={sample_rate:?}",
    );

    {
        let mut recorder = recorder
            .lock()
            .map_err(|e| format!("Failed to lock recorder: {e}"))?;
        recorder.init_session(device_identifier, recording_id, sample_rate)?;
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

/// Returns the captured PCM as a binary IPC body, not JSON. The wire
/// layout is documented on `CapturedPcm::to_binary`: raw little-endian
/// f32 samples, no header. Avoids the 5-7 MB JSON serialize/parse round
/// trip a 30 s clip would cost otherwise.
#[tauri::command]
pub async fn stop_recording(
    recorder: State<'_, Mutex<Recorder>>,
    app_handle: AppHandle,
) -> Result<Response> {
    info!("Stopping recording");
    let pcm = {
        let mut recorder = recorder
            .lock()
            .map_err(|e| format!("Failed to lock recorder: {e}"))?;
        recorder.stop_recording()?
    };
    emit_recording_state(&app_handle, RecordingState::Idle);
    Ok(Response::new(pcm.to_binary()))
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
