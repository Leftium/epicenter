mod error;
mod model_manager;

use crate::audio;
use error::TranscriptionError;
use log::{debug, info, warn};
pub use model_manager::ModelManager;
use model_manager::UnloadPolicy;
use serde::Deserialize;
use std::path::PathBuf;
use tauri::ipc::{InvokeBody, Request};
use transcribe_rs::onnx::moonshine::MoonshineVariant;
use transcribe_rs::onnx::parakeet::{ParakeetParams, TimestampGranularity};
use transcribe_rs::whisper_cpp::WhisperInferenceParams;
use transcribe_rs::{SpeechModel, TranscribeOptions};

/// Engine-tagged request body sent in the `x-transcribe-config` header of
/// the `transcribe_audio` command. The audio bytes travel in the raw body,
/// this carries the engine choice plus engine-specific knobs.
///
/// Wire tags match the FE settings (`transcription.service`):
/// `whispercpp` / `parakeet` / `moonshine`. The Whisper variant uses an
/// explicit serde rename because the implementation is whisper.cpp, not
/// just "whisper".
#[derive(Debug, Deserialize)]
#[serde(tag = "engine", rename_all = "lowercase")]
enum TranscribeRequest {
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
#[derive(Debug, Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum MoonshineVariantWire {
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
}

/// Unified transcription Tauri command.
///
/// Audio bytes arrive as the raw IPC body (`InvokeBody::Raw`), which avoids
/// the ~3x overhead of serializing a `Vec<u8>` as a JSON array of numbers.
/// Engine selection and per-engine knobs travel as JSON in the
/// `x-transcribe-config` header.
///
/// JS call shape:
/// ```js
/// invoke('transcribe_audio', audioArrayBuffer, {
///   headers: { 'x-transcribe-config': JSON.stringify(config) }
/// })
/// ```
#[tauri::command]
pub async fn transcribe_audio(
    request: Request<'_>,
    model_manager: tauri::State<'_, ModelManager>,
) -> Result<String, TranscriptionError> {
    let audio_data = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        InvokeBody::Json(_) => {
            return Err(TranscriptionError::AudioReadError {
                message: "Audio must be sent as the raw IPC body, not JSON".to_string(),
            })
        }
    };

    let config_header = request
        .headers()
        .get("x-transcribe-config")
        .ok_or_else(|| TranscriptionError::TranscriptionError {
            message: "Missing x-transcribe-config header on transcribe_audio call".to_string(),
        })?
        .to_str()
        .map_err(|e| TranscriptionError::TranscriptionError {
            message: format!("Invalid x-transcribe-config header bytes: {}", e),
        })?;

    let req: TranscribeRequest =
        serde_json::from_str(config_header).map_err(|e| TranscriptionError::TranscriptionError {
            message: format!("Invalid x-transcribe-config JSON: {}", e),
        })?;

    let manager = model_manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || run_transcription(audio_data, req, manager))
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
pub fn set_unload_policy(policy: String, model_manager: tauri::State<'_, ModelManager>) {
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

/// The synchronous work function. Sample prep, model load, and inference
/// all happen on a blocking-pool thread. All engine dispatch lives here.
fn run_transcription(
    audio_data: Vec<u8>,
    request: TranscribeRequest,
    manager: ModelManager,
) -> Result<String, TranscriptionError> {
    let engine_label = request.engine_label();
    info!(
        "[Transcription] starting {} transcription: audio_bytes={}",
        engine_label,
        audio_data.len(),
    );

    let samples = audio::decode_to_pcm16k_mono(&audio_data).map_err(|e| {
        TranscriptionError::AudioReadError {
            message: e.to_string(),
        }
    })?;
    debug!(
        "[Transcription] decoded {} samples for {} engine",
        samples.len(),
        engine_label,
    );
    if samples.is_empty() {
        warn!("[Transcription] decoder produced zero samples, returning empty transcript");
        return Ok(String::new());
    }

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
            // Moonshine doesn't expose model-specific inference params we use, so use the
            // SpeechModel trait's default-options path.
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
    // For the `Immediately` policy, drop the resident model now that this
    // transcription is done. No-op for any other policy.
    manager.evict_if_immediate();
    Ok(transcript)
}
