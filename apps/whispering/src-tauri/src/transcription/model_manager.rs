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

/// The path and engine are inseparable (engine X is always loaded from
/// path Y), so they share one mutex slot instead of two parallel ones.
type Cached = Option<(PathBuf, Engine)>;

#[derive(Clone)]
pub struct ModelManager {
    cached: Arc<Mutex<Cached>>,
}

impl ModelManager {
    pub fn new() -> Self {
        Self {
            cached: Arc::new(Mutex::new(None)),
        }
    }

    pub fn with_whisper<T>(
        &self,
        model_path: PathBuf,
        f: impl FnOnce(&mut WhisperEngine) -> Result<T, TranscriptionError>,
    ) -> Result<T, TranscriptionError> {
        self.with_engine(
            model_path,
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

    /// Hold the cache lock across both load and inference. If the cached
    /// (path, engine) matches the request, reuse it; otherwise drop it,
    /// load fresh under the same lock, then run `use_engine` while still
    /// holding the lock. This serializes concurrent transcribe calls (only
    /// one engine fits in memory anyway) and eliminates any race where
    /// another thread could swap the engine between a load and a use step.
    fn with_engine<T>(
        &self,
        model_path: PathBuf,
        can_reuse: impl Fn(&Engine) -> bool,
        load: impl FnOnce(&Path) -> Result<Engine, String>,
        use_engine: impl FnOnce(&mut Engine) -> Result<T, TranscriptionError>,
    ) -> Result<T, TranscriptionError> {
        let mut guard = lock_cached(&self.cached);

        let reuse = matches!(&*guard, Some((p, e)) if p == &model_path && can_reuse(e));

        if !reuse {
            let _ = guard.take();
            let engine = load(&model_path)
                .map_err(|message| TranscriptionError::ModelLoadError { message })?;
            debug!("[Transcription] model loaded: {}", model_path.display());
            *guard = Some((model_path, engine));
        }

        let (_, engine) = guard.as_mut().expect("cache slot populated above");
        use_engine(engine)
    }
}

/// Lock the cache slot, recovering from poisoning by clearing the cached
/// (path, engine) so the next caller reloads from scratch instead of
/// reusing corrupted state from a previous panic.
fn lock_cached(cached: &Mutex<Cached>) -> MutexGuard<'_, Cached> {
    cached.lock().unwrap_or_else(|poisoned| {
        warn!(
            "[Transcription] Cache mutex was poisoned from previous panic, clearing state to force reload..."
        );
        let mut recovered = poisoned.into_inner();
        *recovered = None;
        recovered
    })
}
