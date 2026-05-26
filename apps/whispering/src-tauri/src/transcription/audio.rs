//! Audio normalization for local transcription.
//!
//! All three local engines (Whisper, Parakeet, Moonshine) require 16 kHz
//! mono 16-bit PCM samples. The frontend can send anything WebAudio/cpal
//! produces (44.1/48 kHz, stereo, f32, MP3/OGG/etc), so this module owns
//! the conversion pipeline.
//!
//! Public surface is small: `prepare_samples_for_transcription(bytes,
//! engine_label)` returns `Option<Vec<f32>>` (None = empty audio, the
//! caller should short-circuit to an empty transcript).

use super::error::TranscriptionError;
use log::{debug, error, warn};
use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};
use std::io::Write;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Top-level entry point. Convert opaque audio bytes into f32 PCM samples
/// at 16 kHz mono, ready for inference. `engine_label` is only used for
/// logging.
///
/// Returns `Ok(None)` if the input decodes to zero samples (so the caller
/// can return an empty transcript without going through inference).
pub(super) fn prepare_samples_for_transcription(
    audio_data: Vec<u8>,
    engine_label: &str,
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
        engine_label
    );

    if samples.is_empty() {
        warn!("[Transcription] no samples extracted, returning empty transcription");
        return Ok(None);
    }

    Ok(Some(samples))
}

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
            debug!("[Audio Conversion] tier 2: pure Rust conversion succeeded");
            return Ok(converted);
        }
        Err(e) => {
            warn!(
                "[Audio Conversion] tier 2: pure Rust audio conversion failed ({}), falling back to tier 3 (FFmpeg)",
                e
            );
        }
    }

    // Tier 3: FFmpeg fallback for complex formats (MP3, M4A, OGG, etc.)
    convert_audio_with_ffmpeg(audio_data)
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
        hound::SampleFormat::Int => match spec.bits_per_sample {
            16 => reader
                .samples::<i16>()
                .map(|s| s.map(|sample| sample as f32 / 32768.0))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| TranscriptionError::AudioReadError {
                    message: format!("Failed to read 16-bit samples: {}", e),
                })?,
            32 => reader
                .samples::<i32>()
                .map(|s| s.map(|sample| sample as f32 / 2147483648.0))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| TranscriptionError::AudioReadError {
                    message: format!("Failed to read 32-bit samples: {}", e),
                })?,
            _ => {
                return Err(TranscriptionError::AudioReadError {
                    message: format!("Unsupported bit depth: {} bits", spec.bits_per_sample),
                });
            }
        },
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| TranscriptionError::AudioReadError {
                message: format!("Failed to read float samples: {}", e),
            })?,
    };

    debug!("[Rust Audio Conversion] read {} samples", samples_f32.len());

    // Step 2: Convert channels to mono (if needed)
    let mono_samples: Vec<f32> = if channels == 1 {
        debug!("[Rust Audio Conversion] audio is already mono");
        samples_f32
    } else if channels == 2 {
        debug!("[Rust Audio Conversion] converting stereo to mono by averaging channels");
        samples_f32
            .chunks_exact(2)
            .map(|chunk| (chunk[0] + chunk[1]) / 2.0)
            .collect()
    } else {
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

        let resample_ratio = 16000.0 / sample_rate as f64;
        let expected_output_len = (mono_samples.len() as f64 * resample_ratio).round() as usize;

        debug!(
            "[Rust Audio Conversion] expected output length: {} samples",
            expected_output_len
        );

        if resample_ratio > 8.0 {
            return Err(TranscriptionError::AudioReadError {
                message: format!(
                    "Sample rate {} Hz is too low (minimum 2000 Hz)",
                    sample_rate
                ),
            });
        }

        // Calculate resampling parameters (optimized for speech)
        let chunk_size = 1024;
        let params = SincInterpolationParameters {
            sinc_len: 64,
            f_cutoff: 0.95,
            interpolation: SincInterpolationType::Linear,
            oversampling_factor: 128,
            window: WindowFunction::BlackmanHarris2,
        };

        let mut resampler = SincFixedIn::<f32>::new(resample_ratio, 8.0, params, chunk_size, 1)
            .map_err(|e| {
                error!("[Rust Audio Conversion] failed to create resampler: {}", e);
                TranscriptionError::AudioReadError {
                    message: format!("Failed to create resampler: {}", e),
                }
            })?;

        let mut output_samples = Vec::with_capacity(expected_output_len);
        let mut input_pos = 0;

        debug!(
            "[Rust Audio Conversion] processing in chunks of {} samples",
            chunk_size
        );

        while input_pos < mono_samples.len() {
            let end_pos = (input_pos + chunk_size).min(mono_samples.len());
            let mut chunk: Vec<f32> = mono_samples[input_pos..end_pos].to_vec();

            if chunk.len() < chunk_size {
                chunk.resize(chunk_size, 0.0);
            }

            let waves_in = vec![chunk];

            let waves_out = resampler.process(&waves_in, None).map_err(|e| {
                error!(
                    "[Rust Audio Conversion] resampling failed at position {}: {}",
                    input_pos, e
                );
                TranscriptionError::AudioReadError {
                    message: format!("Resampling failed: {}", e),
                }
            })?;

            output_samples.extend_from_slice(&waves_out[0]);

            input_pos += chunk_size;
        }

        output_samples.truncate(expected_output_len);

        debug!(
            "[Rust Audio Conversion] resampling complete: {} samples -> {} samples (expected: {})",
            mono_samples.len(),
            output_samples.len(),
            expected_output_len
        );
        output_samples
    } else {
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

/// Decode compressed audio (MP3, M4A, OGG, etc.) by streaming the bytes
/// through FFmpeg's stdin. The output WAV is still written to a temp file
/// because FFmpeg's WAV muxer stamps the byte-count fields in the header
/// after the fact, which it cannot do on a non-seekable pipe.
fn convert_audio_with_ffmpeg(audio_data: Vec<u8>) -> Result<Vec<u8>, TranscriptionError> {
    let output_file = tempfile::Builder::new()
        .suffix(".wav")
        .tempfile()
        .map_err(|e| TranscriptionError::AudioReadError {
            message: format!("Failed to create output file: {}", e),
        })?;

    let mut child = {
        let mut cmd = std::process::Command::new("ffmpeg");
        cmd.args(&[
            "-i", "-",
            "-ar", "16000",
            "-ac", "1",
            "-c:a", "pcm_s16le",
            "-y",
            &output_file.path().to_string_lossy(),
        ]);
        cmd.stdin(std::process::Stdio::piped());
        cmd.stdout(std::process::Stdio::null());
        cmd.stderr(std::process::Stdio::piped());
        #[cfg(target_os = "windows")]
        {
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        cmd.spawn()
    }
    .map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            TranscriptionError::FfmpegNotFoundError {
                message: "FFmpeg is not installed. Install FFmpeg to convert audio formats for local transcription.".to_string(),
            }
        } else {
            TranscriptionError::AudioReadError {
                message: format!("Failed to spawn ffmpeg: {}", e),
            }
        }
    })?;

    // Feed stdin from a worker thread so the parent can drain stderr
    // concurrently. Without this, a chatty FFmpeg log on a large input
    // would fill the stderr pipe buffer (~64 KiB) and deadlock: FFmpeg
    // blocks on stderr write, we block on stdin write.
    let mut stdin = child.stdin.take().expect("stdin was piped above");
    let writer = std::thread::spawn(move || stdin.write_all(&audio_data));

    let output = child
        .wait_with_output()
        .map_err(|e| TranscriptionError::AudioReadError {
            message: format!("Failed to wait for ffmpeg: {}", e),
        })?;

    // The write result is intentionally not surfaced: if FFmpeg failed
    // it closed stdin early and the real diagnostic is its stderr; if
    // FFmpeg succeeded it consumed enough input to produce a valid WAV
    // and any tail write error is noise.
    let _ = writer.join().expect("stdin writer thread");

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
