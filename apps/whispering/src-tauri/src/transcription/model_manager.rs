use super::error::TranscriptionError;
use log::{debug, warn};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use transcribe_rs::onnx::moonshine::{MoonshineModel, MoonshineVariant};
use transcribe_rs::onnx::parakeet::ParakeetModel;
use transcribe_rs::onnx::Quantization;
use transcribe_rs::whisper_cpp::WhisperEngine;

/// Engine type for managing different transcription engines.
/// Dropping a variant releases the underlying model resources.
enum Engine {
    Whisper(WhisperEngine),
    Parakeet(ParakeetModel),
    Moonshine(MoonshineModel),
}

#[derive(Clone)]
pub struct ModelManager {
    engine: Arc<Mutex<Option<Engine>>>,
    current_model_path: Arc<Mutex<Option<PathBuf>>>,
}

impl ModelManager {
    pub fn new() -> Self {
        Self {
            engine: Arc::new(Mutex::new(None)),
            current_model_path: Arc::new(Mutex::new(None)),
        }
    }

    pub fn with_whisper<T>(
        &self,
        model_path: PathBuf,
        f: impl FnOnce(&mut WhisperEngine) -> Result<T, TranscriptionError>,
    ) -> Result<T, TranscriptionError> {
        self.with_engine(
            model_path,
            "Whisper",
            |e| matches!(e, Engine::Whisper(_)),
            |path| {
                WhisperEngine::load(path)
                    .map(Engine::Whisper)
                    .map_err(|e| format!("Failed to load Whisper model: {}", e))
            },
            |engine| match engine {
                Engine::Whisper(e) => f(e),
                _ => unreachable!("can_reuse guarantees Whisper variant"),
            },
        )
    }

    pub fn with_parakeet<T>(
        &self,
        model_path: PathBuf,
        f: impl FnOnce(&mut ParakeetModel) -> Result<T, TranscriptionError>,
    ) -> Result<T, TranscriptionError> {
        self.with_engine(
            model_path,
            "Parakeet",
            |e| matches!(e, Engine::Parakeet(_)),
            |path| {
                ParakeetModel::load(path, &Quantization::Int8)
                    .map(Engine::Parakeet)
                    .map_err(|e| format!("Failed to load Parakeet model: {}", e))
            },
            |engine| match engine {
                Engine::Parakeet(e) => f(e),
                _ => unreachable!("can_reuse guarantees Parakeet variant"),
            },
        )
    }

    pub fn with_moonshine<T>(
        &self,
        model_path: PathBuf,
        variant: MoonshineVariant,
        f: impl FnOnce(&mut MoonshineModel) -> Result<T, TranscriptionError>,
    ) -> Result<T, TranscriptionError> {
        self.with_engine(
            model_path,
            "Moonshine",
            |e| matches!(e, Engine::Moonshine(_)),
            |path| {
                MoonshineModel::load(path, variant, &Quantization::default())
                    .map(Engine::Moonshine)
                    .map_err(|e| format!("Failed to load Moonshine model: {}", e))
            },
            |engine| match engine {
                Engine::Moonshine(e) => f(e),
                _ => unreachable!("can_reuse guarantees Moonshine variant"),
            },
        )
    }

    /// Hold the engine lock across both load and inference. The lock is
    /// taken once: if the cached engine matches `can_reuse` for the same
    /// path, reuse it; otherwise drop it, load fresh, then run `use_engine`
    /// while still holding the lock. This serializes concurrent transcribe
    /// calls (one engine in memory anyway) and eliminates the race where
    /// another thread could swap the engine between a load and a use step.
    fn with_engine<T>(
        &self,
        model_path: PathBuf,
        engine_label: &str,
        can_reuse: impl Fn(&Engine) -> bool,
        load: impl FnOnce(&Path) -> Result<Engine, String>,
        use_engine: impl FnOnce(&mut Engine) -> Result<T, TranscriptionError>,
    ) -> Result<T, TranscriptionError> {
        let mut engine_guard = lock_engine(&self.engine);
        let mut path_guard = lock_path(&self.current_model_path);

        let reuse = matches!(
            (&*engine_guard, &*path_guard),
            (Some(e), Some(p)) if p == &model_path && can_reuse(e)
        );

        if !reuse {
            let _ = engine_guard.take();
            let engine = load(&model_path)
                .map_err(|message| TranscriptionError::ModelLoadError { message })?;
            *engine_guard = Some(engine);
            *path_guard = Some(model_path);
            debug!(
                "[Transcription] {} model loaded: {}",
                engine_label,
                path_guard.as_ref().unwrap().display()
            );
        }
        drop(path_guard);

        let engine = engine_guard
            .as_mut()
            .expect("engine slot populated above");
        use_engine(engine)
    }
}

/// Lock the engine slot, recovering from poisoning by clearing the cached
/// engine so the next caller reloads from scratch instead of reusing
/// corrupted state from a previous panic.
fn lock_engine(engine: &Mutex<Option<Engine>>) -> MutexGuard<'_, Option<Engine>> {
    engine.lock().unwrap_or_else(|poisoned| {
        warn!(
            "[Transcription] Engine mutex was poisoned from previous panic, clearing state to force reload..."
        );
        let mut recovered = poisoned.into_inner();
        *recovered = None;
        recovered
    })
}

/// Lock the model-path slot, recovering from poisoning by clearing it
/// so the next load is not gated by a stale path comparison.
fn lock_path(path: &Mutex<Option<PathBuf>>) -> MutexGuard<'_, Option<PathBuf>> {
    path.lock().unwrap_or_else(|poisoned| {
        let mut recovered = poisoned.into_inner();
        *recovered = None;
        recovered
    })
}
