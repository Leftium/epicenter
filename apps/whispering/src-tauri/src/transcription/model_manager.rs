use super::error::TranscriptionError;
use log::{error, warn};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};
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
    last_activity: Arc<Mutex<SystemTime>>,
    idle_timeout: Duration,
}

impl ModelManager {
    pub fn new() -> Self {
        Self {
            engine: Arc::new(Mutex::new(None)),
            current_model_path: Arc::new(Mutex::new(None)),
            last_activity: Arc::new(Mutex::new(SystemTime::now())),
            idle_timeout: Duration::from_secs(5 * 60), // 5 minutes default
        }
    }

    fn get_or_load_parakeet(
        &self,
        model_path: PathBuf,
    ) -> Result<Arc<Mutex<Option<Engine>>>, String> {
        let mut engine_guard = self.engine.lock().map_err(|e| {
            format!(
                "Engine mutex poisoned (likely due to previous panic): {}",
                e
            )
        })?;
        let mut current_path_guard = self.current_model_path.lock().map_err(|e| {
            format!(
                "Model path mutex poisoned (likely due to previous panic): {}",
                e
            )
        })?;

        // Check if we need to load a new model
        let needs_load = match (&*engine_guard, &*current_path_guard) {
            (None, _) => true,
            (Some(_), Some(path)) if path != &model_path => {
                // Different model requested, drop current one
                let _ = engine_guard.take();
                true
            }
            (Some(Engine::Whisper(_)), _) | (Some(Engine::Moonshine(_)), _) => {
                // Wrong engine type, drop and reload
                let _ = engine_guard.take();
                true
            }
            _ => false,
        };

        if needs_load {
            let engine = ParakeetModel::load(&model_path, &Quantization::Int8)
                .map_err(|e| format!("Failed to load Parakeet model: {}", e))?;

            *engine_guard = Some(Engine::Parakeet(engine));
            *current_path_guard = Some(model_path);
        }

        // Update last activity
        let mut last_activity_guard = self
            .last_activity
            .lock()
            .map_err(|e| format!("Last activity mutex poisoned: {}", e))?;
        *last_activity_guard = SystemTime::now();

        Ok(self.engine.clone())
    }

    fn get_or_load_whisper(
        &self,
        model_path: PathBuf,
    ) -> Result<Arc<Mutex<Option<Engine>>>, String> {
        let mut engine_guard = self.engine.lock().map_err(|e| {
            format!(
                "Engine mutex poisoned (likely due to previous panic): {}",
                e
            )
        })?;
        let mut current_path_guard = self.current_model_path.lock().map_err(|e| {
            format!(
                "Model path mutex poisoned (likely due to previous panic): {}",
                e
            )
        })?;

        // Check if we need to load a new model
        let needs_load = match (&*engine_guard, &*current_path_guard) {
            (None, _) => true,
            (Some(_), Some(path)) if path != &model_path => {
                let _ = engine_guard.take();
                true
            }
            (Some(Engine::Parakeet(_)), _) | (Some(Engine::Moonshine(_)), _) => {
                let _ = engine_guard.take();
                true
            }
            _ => false,
        };

        if needs_load {
            let engine = WhisperEngine::load(&model_path)
                .map_err(|e| format!("Failed to load Whisper model: {}", e))?;

            *engine_guard = Some(Engine::Whisper(engine));
            *current_path_guard = Some(model_path);
        }

        // Update last activity
        let mut last_activity_guard = self
            .last_activity
            .lock()
            .map_err(|e| format!("Last activity mutex poisoned: {}", e))?;
        *last_activity_guard = SystemTime::now();

        Ok(self.engine.clone())
    }

    fn get_or_load_moonshine(
        &self,
        model_path: PathBuf,
        variant: MoonshineVariant,
    ) -> Result<Arc<Mutex<Option<Engine>>>, String> {
        let mut engine_guard = self.engine.lock().map_err(|e| {
            format!(
                "Engine mutex poisoned (likely due to previous panic): {}",
                e
            )
        })?;
        let mut current_path_guard = self.current_model_path.lock().map_err(|e| {
            format!(
                "Model path mutex poisoned (likely due to previous panic): {}",
                e
            )
        })?;

        // Check if we need to load a new model
        let needs_load = match (&*engine_guard, &*current_path_guard) {
            (None, _) => true,
            (Some(_), Some(path)) if path != &model_path => {
                let _ = engine_guard.take();
                true
            }
            (Some(Engine::Whisper(_)), _) | (Some(Engine::Parakeet(_)), _) => {
                let _ = engine_guard.take();
                true
            }
            _ => false,
        };

        if needs_load {
            let engine = MoonshineModel::load(&model_path, variant, &Quantization::default())
                .map_err(|e| format!("Failed to load Moonshine model: {}", e))?;

            *engine_guard = Some(Engine::Moonshine(engine));
            *current_path_guard = Some(model_path);
        }

        // Update last activity
        let mut last_activity_guard = self
            .last_activity
            .lock()
            .map_err(|e| format!("Last activity mutex poisoned: {}", e))?;
        *last_activity_guard = SystemTime::now();

        Ok(self.engine.clone())
    }

    pub fn unload_if_idle(&self) {
        let last_activity = match self.last_activity.lock() {
            Ok(guard) => *guard,
            Err(e) => {
                error!(
                    "Last activity mutex poisoned while checking idle unload: {}",
                    e
                );
                return;
            }
        };
        let elapsed = SystemTime::now()
            .duration_since(last_activity)
            .unwrap_or(Duration::from_secs(0));

        if elapsed > self.idle_timeout {
            let mut engine_guard = match self.engine.lock() {
                Ok(guard) => guard,
                Err(e) => {
                    error!("Engine mutex poisoned while unloading idle model: {}", e);
                    return;
                }
            };
            let _ = engine_guard.take();
            if let Ok(mut current_path_guard) = self.current_model_path.lock() {
                *current_path_guard = None;
            } else {
                error!("Model path mutex poisoned while clearing idle model path after unload");
            }
        }
    }

    pub fn unload_model(&self) {
        let mut engine_guard = match self.engine.lock() {
            Ok(guard) => guard,
            Err(e) => {
                error!("Engine mutex poisoned while unloading model: {}", e);
                return;
            }
        };
        let _ = engine_guard.take();
        if let Ok(mut current_path_guard) = self.current_model_path.lock() {
            *current_path_guard = None;
        } else {
            error!("Model path mutex poisoned while clearing model path after unload");
        }
    }

    pub fn with_whisper<T>(
        &self,
        model_path: PathBuf,
        f: impl FnOnce(&mut WhisperEngine) -> Result<T, TranscriptionError>,
    ) -> Result<T, TranscriptionError> {
        let engine_arc = self
            .get_or_load_whisper(model_path)
            .map_err(|message| TranscriptionError::ModelLoadError { message })?;
        with_typed_engine(&engine_arc, |engine| match engine {
            Engine::Whisper(e) => Ok(e),
            _ => Err(TranscriptionError::ModelLoadError {
                message: "Expected Whisper engine but got different type".to_string(),
            }),
        }, f)
    }

    pub fn with_parakeet<T>(
        &self,
        model_path: PathBuf,
        f: impl FnOnce(&mut ParakeetModel) -> Result<T, TranscriptionError>,
    ) -> Result<T, TranscriptionError> {
        let engine_arc = self
            .get_or_load_parakeet(model_path)
            .map_err(|message| TranscriptionError::ModelLoadError { message })?;
        with_typed_engine(&engine_arc, |engine| match engine {
            Engine::Parakeet(e) => Ok(e),
            _ => Err(TranscriptionError::ModelLoadError {
                message: "Expected Parakeet engine but got different type".to_string(),
            }),
        }, f)
    }

    pub fn with_moonshine<T>(
        &self,
        model_path: PathBuf,
        variant: MoonshineVariant,
        f: impl FnOnce(&mut MoonshineModel) -> Result<T, TranscriptionError>,
    ) -> Result<T, TranscriptionError> {
        let engine_arc = self
            .get_or_load_moonshine(model_path, variant)
            .map_err(|message| TranscriptionError::ModelLoadError { message })?;
        with_typed_engine(&engine_arc, |engine| match engine {
            Engine::Moonshine(e) => Ok(e),
            _ => Err(TranscriptionError::ModelLoadError {
                message: "Expected Moonshine engine but got different type".to_string(),
            }),
        }, f)
    }
}

/// Lock the engine slot, recover from poisoning by clearing the cached
/// engine so the next get_or_load_* call reloads from scratch, then
/// project to the typed engine the caller asked for.
fn with_typed_engine<E, T>(
    engine_arc: &Arc<Mutex<Option<Engine>>>,
    project: impl FnOnce(&mut Engine) -> Result<&mut E, TranscriptionError>,
    f: impl FnOnce(&mut E) -> Result<T, TranscriptionError>,
) -> Result<T, TranscriptionError> {
    let mut engine_guard = engine_arc.lock().unwrap_or_else(|poisoned| {
        warn!(
            "[Transcription] Engine mutex was poisoned from previous panic, clearing state to force reload..."
        );
        let mut recovered = poisoned.into_inner();
        *recovered = None;
        recovered
    });
    let engine = engine_guard
        .as_mut()
        .ok_or_else(|| TranscriptionError::ModelLoadError {
            message: "Model not loaded (may have been cleared after previous error). Please try again."
                .to_string(),
        })?;
    let typed = project(engine)?;
    f(typed)
}
