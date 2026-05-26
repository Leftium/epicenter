//! Storage sinks for the consumer worker.
//!
//! The consumer worker holds a `Box<dyn Sink>` and treats both
//! [`MemorySink`] and [`ProgressiveWavSink`] identically: write chunks
//! during capture, finalize into an [`AudioArtifact`] on stop, or cancel
//! (delete file artifacts) on cancel.

use std::path::PathBuf;

use log::debug;

use crate::recorder::artifact::{AudioArtifact, AudioContainer};
use crate::recorder::wav_writer::WavWriter;

pub type Result<T> = std::result::Result<T, String>;

/// Object-safe storage trait. The consumer worker hands chunks in, then
/// calls exactly one of `finalize` or `cancel` to consume the sink.
pub trait Sink: Send {
    /// Persist a chunk of mono f32 samples. Implementations may buffer or
    /// flush; the consumer worker does not assume durability per call.
    fn write_chunk(&mut self, samples: &[f32]) -> Result<()>;

    /// Consume the sink and produce the canonical artifact. `pad_to_samples`
    /// is `Some(n)` when the policy asks for short-clip padding (1.25s of
    /// silence appended if the recording is under 1s); `None` to leave the
    /// captured length untouched.
    fn finalize(self: Box<Self>, pad_to_samples: Option<usize>) -> Result<AudioArtifact>;

    /// Consume the sink and discard. For file-backed sinks this removes
    /// the on-disk artifact so cancel-on-active leaves no orphan.
    fn cancel(self: Box<Self>) -> Result<()>;
}

/// Pure in-memory accumulation. Used for dictation. Samples land at the
/// rate the consumer worker chose (post-resample if the policy resampled),
/// so the artifact's `rate` is what the consumer produced, not what the
/// device captured.
pub struct MemorySink {
    samples: Vec<f32>,
    rate: u32,
    channels: u16,
}

impl MemorySink {
    pub fn new(rate: u32, channels: u16) -> Self {
        Self {
            samples: Vec::new(),
            rate,
            channels,
        }
    }
}

impl Sink for MemorySink {
    fn write_chunk(&mut self, samples: &[f32]) -> Result<()> {
        self.samples.extend_from_slice(samples);
        Ok(())
    }

    fn finalize(self: Box<Self>, pad_to_samples: Option<usize>) -> Result<AudioArtifact> {
        let me = *self;
        let mut samples = me.samples;
        let rate = me.rate;
        let channels = me.channels;

        if let Some(target) = pad_to_samples {
            let samples_per_second = rate as usize * channels as usize;
            if !samples.is_empty() && samples.len() < samples_per_second && samples.len() < target {
                let added = target - samples.len();
                samples.resize(target, 0.0);
                debug!(
                    "MemorySink padded short recording: +{} silent samples ({:.2}s total)",
                    added,
                    samples.len() as f32 / (rate as f32 * channels as f32),
                );
            }
        }

        let duration_seconds = samples.len() as f32 / (rate as f32 * channels as f32);
        Ok(AudioArtifact::Pcm {
            samples,
            rate,
            channels,
            duration_seconds,
        })
    }

    fn cancel(self: Box<Self>) -> Result<()> {
        Ok(())
    }
}

/// Disk-backed sink for longform. Wraps the existing
/// [`crate::recorder::wav_writer::WavWriter`]: the writer keeps periodic
/// header updates so the file is playable up to ~1s before any crash.
pub struct ProgressiveWavSink {
    writer: WavWriter,
    path: PathBuf,
    samples_written: u64,
}

impl ProgressiveWavSink {
    pub fn new(path: PathBuf, sample_rate: u32, channels: u16) -> Result<Self> {
        let writer = WavWriter::new(path.clone(), sample_rate, channels)
            .map_err(|e| format!("Failed to create WAV file: {e}"))?;
        Ok(Self {
            writer,
            path,
            samples_written: 0,
        })
    }
}

impl Sink for ProgressiveWavSink {
    fn write_chunk(&mut self, samples: &[f32]) -> Result<()> {
        self.writer
            .write_samples_f32(samples)
            .map_err(|e| format!("WAV write failed: {e}"))?;
        self.samples_written += samples.len() as u64;
        Ok(())
    }

    fn finalize(self: Box<Self>, pad_to_samples: Option<usize>) -> Result<AudioArtifact> {
        let me = *self;
        let mut writer = me.writer;
        let (rate, channels, _) = writer.get_metadata();

        if let Some(target) = pad_to_samples {
            let samples_per_second = rate as u64 * channels as u64;
            if me.samples_written > 0
                && me.samples_written < samples_per_second
                && (me.samples_written as usize) < target
            {
                let to_add = target - me.samples_written as usize;
                let pad_chunk = vec![0.0f32; to_add];
                writer
                    .write_samples_f32(&pad_chunk)
                    .map_err(|e| format!("pad write failed: {e}"))?;
            }
        }

        writer
            .finalize()
            .map_err(|e| format!("WAV finalize failed: {e}"))?;

        let (rate, channels, duration_seconds) = writer.get_metadata();
        Ok(AudioArtifact::File {
            path: me.path.to_string_lossy().into_owned(),
            rate,
            channels,
            duration_seconds,
            container: AudioContainer::Wav,
        })
    }

    fn cancel(self: Box<Self>) -> Result<()> {
        let me = *self;
        drop(me.writer); // best-effort finalize via Drop
        let _ = std::fs::remove_file(&me.path);
        Ok(())
    }
}
