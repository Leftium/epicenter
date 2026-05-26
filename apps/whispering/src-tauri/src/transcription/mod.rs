mod error;
mod model_manager;

use error::TranscriptionError;
use log::{debug, error, info, warn};
pub use model_manager::ModelManager;
use serde::Deserialize;
use std::io::Write;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use tauri::ipc::{InvokeBody, Request};
use transcribe_rs::onnx::moonshine::MoonshineVariant;
use transcribe_rs::onnx::parakeet::{ParakeetParams, TimestampGranularity};
use transcribe_rs::whisper_cpp::WhisperInferenceParams;
use transcribe_rs::{SpeechModel, TranscribeOptions};

/// Engine-tagged request body sent in the `x-transcribe-config` header of
/// the `transcribe_audio` command. The audio bytes travel in the raw body,
/// this carries the engine choice plus engine-specific knobs.
#[derive(Debug, Deserialize)]
#[serde(tag = "engine", rename_all = "lowercase")]
pub enum TranscribeRequest {
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
}

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;
use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};

/// Check if audio is already in whisper-compatible format (16kHz, mono, 16-bit PCM)
fn is_valid_wav_format(audio_data: &[u8]) -> bool {
    let cursor = std::io::Cursor::new(audio_data);

    if let Ok(reader) = hound::WavReader::new(cursor) {
        let spec = reader.spec();
        spec.sample_format == hound::SampleFormat::Int &&
        spec.channels == 1 &&          // Must be mono
        spec.sample_rate == 16000 &&   // Must be 16kHz
        spec.bits_per_sample == 16 // Must be 16-bit
    } else {
        false
    }
}

/// Convert audio to whisper-compatible format using pure Rust (no FFmpeg required)
///
/// This function converts audio from various formats to 16kHz mono 16-bit PCM WAV.
/// It handles:
/// - Channel conversion: stereo → mono (by averaging channels)
/// - Sample format conversion: any format → f32 → 16-bit PCM
/// - Sample rate conversion: any Hz → 16kHz using high-quality resampling
///
/// This is used as a fallback when FFmpeg is not available, and can handle
/// most uncompressed WAV formats. For compressed formats (MP3, M4A, etc.),
/// FFmpeg is still required.
fn convert_audio_rust(audio_data: Vec<u8>) -> Result<Vec<u8>, TranscriptionError> {
    debug!(
        "[Rust Audio Conversion] starting conversion of {} bytes",
        audio_data.len()
    );

    // Read the input WAV file
    let cursor = std::io::Cursor::new(&audio_data);
    let mut reader = hound::WavReader::new(cursor).map_err(|e| {
        error!("[Rust Audio Conversion] failed to parse WAV file: {}", e);
        TranscriptionError::AudioReadError {
            message: format!("Failed to parse WAV file: {}", e),
        }
    })?;

    let spec = reader.spec();
    let sample_rate = spec.sample_rate;
    let channels = spec.channels as usize;

    debug!(
        "[Rust Audio Conversion] input format: {} Hz, {} channels, {} bits, {:?} format",
        sample_rate, channels, spec.bits_per_sample, spec.sample_format
    );

    // Step 1: Read all samples and convert to f32 (normalized to [-1.0, 1.0])
    let samples_f32: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Int => {
            match spec.bits_per_sample {
                16 => {
                    // 16-bit PCM: divide by 32768.0 to normalize
                    reader
                        .samples::<i16>()
                        .map(|s| s.map(|sample| sample as f32 / 32768.0))
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(|e| TranscriptionError::AudioReadError {
                            message: format!("Failed to read 16-bit samples: {}", e),
                        })?
                }
                32 => {
                    // 32-bit PCM: divide by 2147483648.0 to normalize
                    reader
                        .samples::<i32>()
                        .map(|s| s.map(|sample| sample as f32 / 2147483648.0))
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(|e| TranscriptionError::AudioReadError {
                            message: format!("Failed to read 32-bit samples: {}", e),
                        })?
                }
                _ => {
                    return Err(TranscriptionError::AudioReadError {
                        message: format!("Unsupported bit depth: {} bits", spec.bits_per_sample),
                    });
                }
            }
        }
        hound::SampleFormat::Float => {
            // 32-bit float: already in [-1.0, 1.0] range
            reader
                .samples::<f32>()
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| TranscriptionError::AudioReadError {
                    message: format!("Failed to read float samples: {}", e),
                })?
        }
    };

    debug!("[Rust Audio Conversion] read {} samples", samples_f32.len());

    // Step 2: Convert channels to mono (if needed)
    let mono_samples: Vec<f32> = if channels == 1 {
        // Already mono, use as-is
        debug!("[Rust Audio Conversion] audio is already mono");
        samples_f32
    } else if channels == 2 {
        // Stereo: average left and right channels
        debug!("[Rust Audio Conversion] converting stereo to mono by averaging channels");
        samples_f32
            .chunks_exact(2)
            .map(|chunk| (chunk[0] + chunk[1]) / 2.0)
            .collect()
    } else {
        // More than 2 channels: average all channels
        debug!(
            "[Rust Audio Conversion] converting {} channels to mono by averaging",
            channels
        );
        samples_f32
            .chunks_exact(channels)
            .map(|chunk| chunk.iter().sum::<f32>() / channels as f32)
            .collect()
    };

    debug!(
        "[Rust Audio Conversion] mono samples: {}",
        mono_samples.len()
    );

    // Step 3: Resample to 16kHz (if needed)
    let resampled: Vec<f32> = if sample_rate != 16000 {
        debug!(
            "[Rust Audio Conversion] resampling from {} Hz to 16000 Hz",
            sample_rate
        );

        // Calculate resample ratio and expected output length
        let resample_ratio = 16000.0 / sample_rate as f64;
        let expected_output_len = (mono_samples.len() as f64 * resample_ratio).round() as usize;

        debug!(
            "[Rust Audio Conversion] expected output length: {} samples",
            expected_output_len
        );

        // Validate sample rate (support down to 2kHz)
        if resample_ratio > 8.0 {
            return Err(TranscriptionError::AudioReadError {
                message: format!(
                    "Sample rate {} Hz is too low (minimum 2000 Hz)",
                    sample_rate
                ),
            });
        }

        // Calculate resampling parameters (optimized for speech)
        let chunk_size = 1024; // Process in chunks for efficiency
        let params = SincInterpolationParameters {
            sinc_len: 64,   // Reduced from 256 for better performance (adequate for speech)
            f_cutoff: 0.95, // Keep high to preserve speech frequencies
            interpolation: SincInterpolationType::Linear,
            oversampling_factor: 128, // Reduced from 256 (still good quality)
            window: WindowFunction::BlackmanHarris2,
        };

        // Create resampler (1 channel, fixed input rate)
        let mut resampler = SincFixedIn::<f32>::new(
            resample_ratio,
            8.0, // Increased from 2.0 to support down to 2kHz input
            params,
            chunk_size,
            1, // mono
        )
        .map_err(|e| {
            error!("[Rust Audio Conversion] failed to create resampler: {}", e);
            TranscriptionError::AudioReadError {
                message: format!("Failed to create resampler: {}", e),
            }
        })?;

        // Process audio in chunks since SincFixedIn expects fixed-size chunks
        // Pre-allocate output buffer for efficiency
        let mut output_samples = Vec::with_capacity(expected_output_len);
        let mut input_pos = 0;

        debug!(
            "[Rust Audio Conversion] processing in chunks of {} samples",
            chunk_size
        );

        while input_pos < mono_samples.len() {
            // Get the next chunk (pad with zeros if needed for the last chunk)
            let end_pos = (input_pos + chunk_size).min(mono_samples.len());
            let mut chunk: Vec<f32> = mono_samples[input_pos..end_pos].to_vec();

            // Pad the last chunk with zeros if it's smaller than chunk_size
            if chunk.len() < chunk_size {
                chunk.resize(chunk_size, 0.0);
            }

            // Prepare input as a vector of channels (only 1 channel for mono)
            let waves_in = vec![chunk];

            // Resample this chunk
            let waves_out = resampler.process(&waves_in, None).map_err(|e| {
                error!(
                    "[Rust Audio Conversion] resampling failed at position {}: {}",
                    input_pos, e
                );
                TranscriptionError::AudioReadError {
                    message: format!("Resampling failed: {}", e),
                }
            })?;

            // Append the resampled chunk to output
            output_samples.extend_from_slice(&waves_out[0]);

            input_pos += chunk_size;
        }

        // Truncate to expected length to remove artifacts from zero-padding
        output_samples.truncate(expected_output_len);

        debug!(
            "[Rust Audio Conversion] resampling complete: {} samples -> {} samples (expected: {})",
            mono_samples.len(),
            output_samples.len(),
            expected_output_len
        );
        output_samples
    } else {
        // Already at 16kHz
        debug!("[Rust Audio Conversion] audio is already at 16kHz, skipping resampling");
        mono_samples
    };

    // Step 4: Convert f32 samples to 16-bit PCM
    debug!(
        "[Rust Audio Conversion] converting {} f32 samples to 16-bit PCM",
        resampled.len()
    );
    let pcm_samples: Vec<i16> = resampled
        .iter()
        .map(|&sample| {
            // Clamp to [-1.0, 1.0] and convert to i16
            let clamped = sample.max(-1.0).min(1.0);
            (clamped * 32767.0) as i16
        })
        .collect();

    debug!(
        "[Rust Audio Conversion] converted to {} PCM samples",
        pcm_samples.len()
    );

    // Step 5: Write output WAV to memory buffer
    let mut cursor = std::io::Cursor::new(Vec::new());
    {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };

        let mut writer = hound::WavWriter::new(&mut cursor, spec).map_err(|e| {
            TranscriptionError::AudioReadError {
                message: format!("Failed to create WAV writer: {}", e),
            }
        })?;

        for sample in pcm_samples {
            writer
                .write_sample(sample)
                .map_err(|e| TranscriptionError::AudioReadError {
                    message: format!("Failed to write sample: {}", e),
                })?;
        }

        writer.finalize().map_err(|e| {
            error!("[Rust Audio Conversion] failed to finalize WAV: {}", e);
            TranscriptionError::AudioReadError {
                message: format!("Failed to finalize WAV: {}", e),
            }
        })?;
    }

    let output_bytes = cursor.into_inner();
    debug!(
        "[Rust Audio Conversion] successfully converted audio: {} bytes output",
        output_bytes.len()
    );
    Ok(output_bytes)
}

/// Convert audio to 16kHz mono 16-bit PCM WAV, the format all three local
/// transcription engines (Whisper, Parakeet, Moonshine) require.
///
/// - Sample rate: 16,000 Hz (not the typical 44.1kHz or 48kHz)
/// - Channels: Mono (1 channel)
/// - Format: 16-bit PCM WAV
///
/// This function uses a three-tier conversion strategy:
///
/// **Tier 1: Format Check (Fast Path)**
/// - Checks if audio is already in the correct format
/// - If yes, returns immediately without any processing
/// - This is the most efficient path for recordings that are already 16kHz mono 16-bit PCM
///
/// **Tier 2: Pure Rust Conversion (Fallback)**
/// - Attempts to convert audio using pure Rust libraries (no external dependencies)
/// - Handles uncompressed WAV files with various sample rates, channels, and bit depths
/// - Uses high-quality resampling (SincFixedIn) for sample rate conversion
/// - Works without FFmpeg installed, making it portable and reliable
///
/// **Tier 3: FFmpeg Conversion (Last Resort)**
/// - Falls back to FFmpeg for complex formats (MP3, M4A, OGG, etc.)
/// - Provides comprehensive format support but requires FFmpeg installation
/// - Returns `FfmpegNotFoundError` if FFmpeg is not available
///
/// This approach ensures maximum compatibility: users without FFmpeg can still
/// transcribe most recordings, while complex formats are handled when FFmpeg is available.
fn convert_audio_to_pcm16k_mono(audio_data: Vec<u8>) -> Result<Vec<u8>, TranscriptionError> {
    debug!(
        "[Audio Conversion] starting 3-tier conversion strategy for {} bytes",
        audio_data.len()
    );

    // Tier 1: Skip conversion if already in correct format (fast path)
    if is_valid_wav_format(&audio_data) {
        debug!(
            "[Audio Conversion] tier 1: audio is already in correct format (16kHz mono 16-bit PCM)"
        );
        return Ok(audio_data);
    }

    debug!("[Audio Conversion] tier 1: audio needs conversion, trying tier 2 (pure Rust)");

    // Tier 2: Try pure Rust conversion (no FFmpeg required)
    match convert_audio_rust(audio_data.clone()) {
        Ok(converted) => {
            // Rust conversion succeeded
            debug!("[Audio Conversion] tier 2: pure Rust conversion succeeded");
            return Ok(converted);
        }
        Err(e) => {
            // Log the error but continue to FFmpeg fallback
            warn!(
                "[Audio Conversion] tier 2: pure Rust audio conversion failed ({}), falling back to tier 3 (FFmpeg)",
                e
            );
        }
    }

    // Tier 3: FFmpeg fallback for complex formats (MP3, M4A, OGG, etc.)
    convert_audio_with_ffmpeg(audio_data)
}

fn convert_audio_with_ffmpeg(audio_data: Vec<u8>) -> Result<Vec<u8>, TranscriptionError> {
    let mut input_file = tempfile::Builder::new()
        .suffix(".audio")
        .tempfile()
        .map_err(|e| TranscriptionError::AudioReadError {
            message: format!("Failed to create temp file: {}", e),
        })?;

    input_file
        .write_all(&audio_data)
        .map_err(|e| TranscriptionError::AudioReadError {
            message: format!("Failed to write audio data: {}", e),
        })?;

    let output_file = tempfile::Builder::new()
        .suffix(".wav")
        .tempfile()
        .map_err(|e| TranscriptionError::AudioReadError {
            message: format!("Failed to create output file: {}", e),
        })?;

    // Use FFmpeg to convert to whisper-compatible format
    let output = {
        let mut cmd = std::process::Command::new("ffmpeg");
        cmd.args(&[
            "-i", &input_file.path().to_string_lossy(),
            "-ar", "16000",        // 16kHz sample rate
            "-ac", "1",            // Mono
            "-c:a", "pcm_s16le",   // 16-bit PCM
            "-y",                  // Overwrite output
            &output_file.path().to_string_lossy(),
        ]);
        #[cfg(target_os = "windows")]
        {
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        cmd.output()
    }
        .map_err(|e| {
            // Check if error is specifically "command not found"
            if e.kind() == std::io::ErrorKind::NotFound {
                TranscriptionError::FfmpegNotFoundError {
                    message: "FFmpeg is not installed. Install FFmpeg to convert audio formats for local transcription.".to_string(),
                }
            } else {
                TranscriptionError::AudioReadError {
                    message: format!("Failed to run ffmpeg: {}", e),
                }
            }
        })?;

    if !output.status.success() {
        return Err(TranscriptionError::AudioReadError {
            message: format!(
                "FFmpeg conversion failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ),
        });
    }

    std::fs::read(output_file.path()).map_err(|e| TranscriptionError::AudioReadError {
        message: format!("Failed to read converted audio: {}", e),
    })
}

/// Parse WAV data and extract samples as f32 vector
fn extract_samples_from_wav(wav_data: Vec<u8>) -> Result<Vec<f32>, TranscriptionError> {
    debug!(
        "[Extract Samples] parsing {} bytes of WAV data",
        wav_data.len()
    );

    let cursor = std::io::Cursor::new(wav_data);
    let mut reader = hound::WavReader::new(cursor).map_err(|e| {
        error!("[Extract Samples] failed to parse WAV: {}", e);
        TranscriptionError::AudioReadError {
            message: format!("Failed to parse WAV: {}", e),
        }
    })?;

    let spec = reader.spec();
    debug!(
        "[Extract Samples] WAV spec: {} Hz, {} channels, {} bits, {:?} format",
        spec.sample_rate, spec.channels, spec.bits_per_sample, spec.sample_format
    );

    let samples: Vec<f32> = reader
        .samples::<i16>()
        .map(|s| s.map(|sample| sample as f32 / 32768.0))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| {
            error!("[Extract Samples] failed to read samples: {}", e);
            TranscriptionError::AudioReadError {
                message: format!("Failed to read samples: {}", e),
            }
        })?;

    debug!(
        "[Extract Samples] extracted {} samples successfully",
        samples.len()
    );

    if samples.is_empty() {
        warn!("[Extract Samples] no samples extracted from audio");
    }

    Ok(samples)
}

fn prepare_samples_for_transcription(
    audio_data: Vec<u8>,
    engine_name: &str,
) -> Result<Option<Vec<f32>>, TranscriptionError> {
    let wav_data = convert_audio_to_pcm16k_mono(audio_data)?;
    debug!(
        "[Transcription] audio conversion complete: wav_bytes={}",
        wav_data.len()
    );

    let samples = extract_samples_from_wav(wav_data)?;
    debug!(
        "[Transcription] extracted {} PCM samples for {} engine",
        samples.len(),
        engine_name
    );

    if samples.is_empty() {
        warn!("[Transcription] no samples extracted, returning empty transcription");
        return Ok(None);
    }

    Ok(Some(samples))
}

/// Map a join failure from spawn_blocking into a TranscriptionError so the
/// frontend always sees a structured error even when the background task
/// panics or is cancelled.
fn join_err(e: tauri::Error) -> TranscriptionError {
    TranscriptionError::TranscriptionError {
        message: format!("Background transcription task failed: {}", e),
    }
}

/// Unified transcription Tauri command.
///
/// Audio bytes arrive as the raw IPC body (Tauri 2's `InvokeBody::Raw`),
/// which avoids the ~3x overhead of serializing a Vec<u8> as a JSON array
/// of numbers. Engine selection and per-engine knobs travel as JSON in the
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

    run_transcription(audio_data, req, model_manager.inner().clone()).await
}

/// Compat shim: the original Whisper-specific command, kept while the FE
/// migrates to the unified `transcribe_audio` command. Delete once all
/// callers are off it.
#[tauri::command]
pub async fn transcribe_audio_whisper(
    audio_data: Vec<u8>,
    model_path: String,
    language: Option<String>,
    initial_prompt: Option<String>,
    model_manager: tauri::State<'_, ModelManager>,
) -> Result<String, TranscriptionError> {
    let req = TranscribeRequest::Whisper {
        model_path,
        language,
        initial_prompt,
    };
    run_transcription(audio_data, req, model_manager.inner().clone()).await
}

/// Compat shim: see `transcribe_audio_whisper`.
#[tauri::command]
pub async fn transcribe_audio_parakeet(
    audio_data: Vec<u8>,
    model_path: String,
    model_manager: tauri::State<'_, ModelManager>,
) -> Result<String, TranscriptionError> {
    let req = TranscribeRequest::Parakeet { model_path };
    run_transcription(audio_data, req, model_manager.inner().clone()).await
}

/// Compat shim: see `transcribe_audio_whisper`. Variant is still parsed from
/// the directory name here for back-compat; the new command takes variant
/// on the wire.
#[tauri::command]
pub async fn transcribe_audio_moonshine(
    audio_data: Vec<u8>,
    model_path: String,
    model_manager: tauri::State<'_, ModelManager>,
) -> Result<String, TranscriptionError> {
    let variant = parse_moonshine_variant(&model_path);
    let req = TranscribeRequest::Moonshine {
        model_path,
        variant,
    };
    run_transcription(audio_data, req, model_manager.inner().clone()).await
}

/// The single transcription work function. Everything CPU-heavy runs inside
/// `spawn_blocking`. All three engines route through here.
async fn run_transcription(
    audio_data: Vec<u8>,
    request: TranscribeRequest,
    manager: ModelManager,
) -> Result<String, TranscriptionError> {
    tauri::async_runtime::spawn_blocking(move || {
        let engine_label = request.engine_label();
        info!(
            "[Transcription] starting {} transcription: audio_bytes={}",
            engine_label,
            audio_data.len(),
        );

        let Some(samples) = prepare_samples_for_transcription(audio_data, engine_label)? else {
            return Ok(String::new());
        };

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
        Ok(transcript)
    })
    .await
    .map_err(join_err)?
}

fn transcription_err(e: impl std::fmt::Display) -> TranscriptionError {
    TranscriptionError::TranscriptionError {
        message: e.to_string(),
    }
}

/// Convert a wire-side Moonshine variant (from a model directory name) into
/// the upstream `MoonshineVariant`. Used only by the compat shim; the new
/// command takes the variant on the wire.
fn parse_moonshine_variant(model_path: &str) -> MoonshineVariantWire {
    let dir_name = std::path::Path::new(model_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    let variant = dir_name.split('-').nth(1).unwrap_or("tiny");

    debug!(
        "[Transcription] extracted Moonshine variant='{}' from path '{}'",
        variant, dir_name
    );

    match variant {
        "base" => MoonshineVariantWire::Base,
        "tiny" => MoonshineVariantWire::Tiny,
        _ => {
            warn!(
                "[Transcription] unknown Moonshine variant '{}' in path '{}', defaulting to tiny",
                variant, dir_name
            );
            MoonshineVariantWire::Tiny
        }
    }
}
