mod error;
mod model_manager;

use crate::recorder::read_artifact_samples;
pub use error::TranscriptionError;
use log::{debug, info, warn};
pub use model_manager::ModelManager;
use model_manager::UnloadPolicy;
use serde::Deserialize;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};
use transcribe_rs::onnx::moonshine::MoonshineVariant;
use transcribe_rs::onnx::parakeet::{ParakeetParams, TimestampGranularity};
use transcribe_rs::whisper_cpp::WhisperInferenceParams;
use transcribe_rs::{SpeechModel, TranscribeOptions};

/// Engine-tagged request body. JS serializes one of these as the `config`
/// JSON argument on the `transcribe_recording` command. Wire tags match
/// the FE settings (`transcription.service`): `whispercpp` / `parakeet` /
/// `moonshine`.
///
/// `pub` + `specta::Type` so the JS side gets the discriminated union as
/// a typed argument via the `tauri-specta` generator. The existing serde
/// tag + rename attributes carry through.
#[derive(Debug, Deserialize, specta::Type)]
#[serde(tag = "engine", rename_all = "lowercase")]
pub enum TranscribeRequest {
    #[serde(rename = "whispercpp")]
    Whisper {
        #[serde(rename = "modelPath")]
        model_path: String,
        #[serde(default)]
        language: Option<String>,
        #[serde(default, rename = "initialPrompt")]
        initial_prompt: Option<String>,
    },
    Parakeet {
        #[serde(rename = "modelPath")]
        model_path: String,
    },
    Moonshine {
        #[serde(rename = "modelPath")]
        model_path: String,
        variant: MoonshineVariantWire,
    },
}

/// Wire representation of the subset of Moonshine variants the app surfaces.
/// `transcribe-rs` exposes more variants but the UI only offers Tiny and Base.
#[derive(Debug, Deserialize, Clone, Copy, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum MoonshineVariantWire {
    Tiny,
    Base,
}

impl From<MoonshineVariantWire> for MoonshineVariant {
    fn from(v: MoonshineVariantWire) -> Self {
        match v {
            MoonshineVariantWire::Tiny => MoonshineVariant::Tiny,
            MoonshineVariantWire::Base => MoonshineVariant::Base,
        }
    }
}

impl TranscribeRequest {
    fn engine_label(&self) -> &'static str {
        match self {
            TranscribeRequest::Whisper { .. } => "Whisper",
            TranscribeRequest::Parakeet { .. } => "Parakeet",
            TranscribeRequest::Moonshine { .. } => "Moonshine",
        }
    }

    fn constrain_model_path(self, app: &AppHandle) -> Result<Self, TranscriptionError> {
        match self {
            TranscribeRequest::Whisper {
                model_path,
                language,
                initial_prompt,
            } => Ok(TranscribeRequest::Whisper {
                model_path: app_model_path(app, model_path)?,
                language,
                initial_prompt,
            }),
            TranscribeRequest::Parakeet { model_path } => Ok(TranscribeRequest::Parakeet {
                model_path: app_model_path(app, model_path)?,
            }),
            TranscribeRequest::Moonshine {
                model_path,
                variant,
            } => Ok(TranscribeRequest::Moonshine {
                model_path: app_model_path(app, model_path)?,
                variant,
            }),
        }
    }
}

/// Canonical transcribe-by-id path. Resolves the audio file under
/// `<appDataDir>/recordings/{recordingId}.*` (cpal-written WAV,
/// navigator-saved webm/opus/mp4, etc.), decodes, runs inference. This
/// is the single entry point for every local transcription call: cpal
/// stop, navigator/VAD/file-upload (after the pipeline saves), retry,
/// history replay.
#[tauri::command]
#[specta::specta]
pub async fn transcribe_recording(
    recording_id: String,
    config: TranscribeRequest,
    app_handle: AppHandle,
    model_manager: State<'_, ModelManager>,
) -> Result<String, TranscriptionError> {
    let config = config.constrain_model_path(&app_handle)?;

    let samples = read_artifact_samples(&app_handle, &recording_id)
        .map_err(|e| TranscriptionError::AudioReadError { message: e })?;

    let manager = model_manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || run_inference(samples, config, manager))
        .await
        .map_err(join_err)?
}

/// Update the model unload policy from the frontend. Called by an effect
/// in the SvelteKit layout whenever `transcription.localModelUnloadPolicy`
/// changes, and once at app startup to push the initial value.
///
/// Unknown values fall back to the default inside `UnloadPolicy::from_wire`
/// rather than erroring, so a future rename or corrupt localStorage value
/// never breaks transcription.
#[tauri::command]
#[specta::specta]
pub fn set_unload_policy(policy: String, model_manager: State<'_, ModelManager>) {
    model_manager.set_policy(UnloadPolicy::from_wire(&policy));
}

/// Map a join failure from spawn_blocking into a TranscriptionError so the
/// frontend always sees a structured error even when the background task
/// panics or is cancelled.
fn join_err(e: tauri::Error) -> TranscriptionError {
    TranscriptionError::TranscriptionError {
        message: format!("Background transcription task failed: {}", e),
    }
}

fn transcription_err(e: impl std::fmt::Display) -> TranscriptionError {
    TranscriptionError::TranscriptionError {
        message: e.to_string(),
    }
}

fn model_load_err(e: impl std::fmt::Display) -> TranscriptionError {
    TranscriptionError::ModelLoadError {
        message: e.to_string(),
    }
}

fn app_model_path(app: &AppHandle, model_path: String) -> Result<String, TranscriptionError> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(model_load_err)?
        .canonicalize()
        .map_err(|e| model_load_err(format!("resolve app data directory: {}", e)))?;
    let models_dir = app_data_dir.join("models");
    let path = PathBuf::from(&model_path)
        .canonicalize()
        .map_err(|e| model_load_err(format!("resolve model path {}: {}", model_path, e)))?;

    if !path.starts_with(&models_dir) {
        return Err(model_load_err(
            "Local model path must be inside the app data models directory",
        ));
    }

    Ok(path.to_string_lossy().to_string())
}

/// Synchronous inference dispatch. Runs on a blocking-pool thread; all
/// engine-specific knobs live here.
fn run_inference(
    samples: Vec<f32>,
    request: TranscribeRequest,
    manager: ModelManager,
) -> Result<String, TranscriptionError> {
    let engine_label = request.engine_label();
    info!(
        "[Transcription] starting {} transcription: pcm_samples={}",
        engine_label,
        samples.len(),
    );

    if samples.is_empty() {
        warn!("[Transcription] zero samples, returning empty transcript");
        return Ok(String::new());
    }
    debug!(
        "[Transcription] running {} on {} samples",
        engine_label,
        samples.len(),
    );

    let transcript = match request {
        TranscribeRequest::Whisper {
            model_path,
            language,
            initial_prompt,
        } => {
            let mut params = WhisperInferenceParams::default();
            params.language = language;
            params.initial_prompt = initial_prompt;
            params.print_special = false;
            params.print_progress = false;
            params.print_realtime = false;
            params.print_timestamps = false;
            params.suppress_blank = true;
            params.suppress_non_speech_tokens = true;
            params.no_speech_thold = 0.2;

            manager.with_whisper(PathBuf::from(model_path), |engine| {
                let result = engine
                    .transcribe_with(&samples, &params)
                    .map_err(transcription_err)?;
                Ok(result.text.trim().to_string())
            })?
        }
        TranscribeRequest::Parakeet { model_path } => {
            let params = ParakeetParams {
                timestamp_granularity: Some(TimestampGranularity::Segment),
                ..Default::default()
            };
            manager.with_parakeet(PathBuf::from(model_path), |engine| {
                let result = engine
                    .transcribe_with(&samples, &params)
                    .map_err(transcription_err)?;
                Ok(result.text.trim().to_string())
            })?
        }
        TranscribeRequest::Moonshine {
            model_path,
            variant,
        } => manager.with_moonshine(PathBuf::from(model_path), variant.into(), |engine| {
            let result = engine
                .transcribe(&samples, &TranscribeOptions::default())
                .map_err(transcription_err)?;
            Ok(result.text.trim().to_string())
        })?,
    };

    info!(
        "[Transcription] {} transcription complete: characters={}",
        engine_label,
        transcript.len()
    );
    manager.evict_if_immediate();
    Ok(transcript)
}
