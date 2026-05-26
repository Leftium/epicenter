use super::error::TranscriptionError;
use log::{debug, info, warn};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use transcribe_rs::onnx::moonshine::{MoonshineModel, MoonshineVariant};
use transcribe_rs::onnx::parakeet::ParakeetModel;
use transcribe_rs::onnx::Quantization;
use transcribe_rs::whisper_cpp::WhisperEngine;

/// How long after the last transcription the resident model should be
/// dropped. Mirrors the frontend setting `transcription.localModelUnloadPolicy`.
///
/// `Immediately` is enforced synchronously at the end of each transcription
/// (see `ModelManager::evict_if_immediate`). Timed variants are enforced by
/// the background idle watcher (see `ModelManager::start_idle_watcher`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnloadPolicy {
    Never,
    Immediately,
    AfterMinutes(u64),
}

impl UnloadPolicy {
    /// Default policy if the frontend never pushes one. Matches the frontend
    /// default so a fresh install behaves identically before any setting
    /// observer fires.
    pub const DEFAULT: Self = Self::AfterMinutes(5);

    /// Parse a wire-format string from the frontend setting. Unknown values
    /// fall back to `DEFAULT` rather than failing so a stale or future value
    /// from a synced workspace never bricks the model layer.
    pub fn from_wire(s: &str) -> Self {
        match s {
            "never" => Self::Never,
            "immediately" => Self::Immediately,
            "after_5_minutes" => Self::AfterMinutes(5),
            "after_30_minutes" => Self::AfterMinutes(30),
            other => {
                warn!(
                    "[Transcription] Unknown unload policy '{}', falling back to default",
                    other
                );
                Self::DEFAULT
            }
        }
    }
}

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
    /// Millis since UNIX_EPOCH of the last transcription start or completion.
    /// `AtomicU64` so the watcher can read it without contending with the
    /// cache mutex held during long inference.
    last_activity_ms: Arc<AtomicU64>,
    /// Current unload policy. `RwLock` because the watcher reads on every
    /// tick while writes only happen when the user changes the setting.
    policy: Arc<RwLock<UnloadPolicy>>,
}

impl ModelManager {
    pub fn new() -> Self {
        Self {
            cached: Arc::new(Mutex::new(None)),
            last_activity_ms: Arc::new(AtomicU64::new(now_millis())),
            policy: Arc::new(RwLock::new(UnloadPolicy::DEFAULT)),
        }
    }

    pub fn set_policy(&self, policy: UnloadPolicy) {
        let mut guard = match self.policy.write() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        if *guard != policy {
            info!("[Transcription] Unload policy changed to {:?}", policy);
            *guard = policy;
        }
    }

    fn current_policy(&self) -> UnloadPolicy {
        match self.policy.read() {
            Ok(g) => *g,
            Err(poisoned) => *poisoned.into_inner(),
        }
    }

    fn touch_activity(&self) {
        self.last_activity_ms.store(now_millis(), Ordering::Relaxed);
    }

    /// Drop the resident model now if the current policy is `Immediately`.
    /// Called at the end of every successful transcription. A no-op for any
    /// other policy.
    ///
    /// Blocking lock acquisition is fine: this runs at the end of a
    /// transcription that just held the same lock, so no contention is
    /// possible at the call site.
    pub fn evict_if_immediate(&self) {
        if matches!(self.current_policy(), UnloadPolicy::Immediately) {
            evict_locked(&mut lock_cached(&self.cached), "immediate");
        }
    }

    /// Start the background idle watcher. Spawns one task on the Tauri
    /// async runtime; safe to call once at app setup. Returns immediately.
    ///
    /// The watcher sleeps between checks, never holds the cache lock while
    /// waiting, and skips ticks where another caller currently holds the
    /// cache (long-running transcription in progress).
    pub fn start_idle_watcher(&self) {
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            // Same cadence as Handy. Coarse on purpose: idle eviction is
            // not latency-sensitive and a 10s tick keeps overhead trivial.
            let tick = Duration::from_secs(10);
            loop {
                tokio::time::sleep(tick).await;
                this.tick_idle();
            }
        });
    }

    /// One iteration of the idle watcher. Pulled out of the spawn closure
    /// so the control flow is straight-line and the awaitless body is
    /// trivially reviewable: read policy, compute idle, `try_lock`, evict.
    fn tick_idle(&self) {
        let Some(timeout) = idle_timeout_for(self.current_policy()) else {
            return;
        };
        let idle = Duration::from_millis(
            now_millis().saturating_sub(self.last_activity_ms.load(Ordering::Relaxed)),
        );
        if idle < timeout {
            return;
        }
        // `try_lock` so a long transcription in progress just postpones
        // eviction to the next tick instead of blocking the watcher.
        let Ok(mut guard) = self.cached.try_lock() else {
            return;
        };
        evict_locked(&mut guard, format_args!("idle {}s", idle.as_secs()));
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
    ///
    /// Stamps activity both before and after the use step so the idle
    /// watcher counts from the *end* of inference, not the start.
    fn with_engine<T>(
        &self,
        model_path: PathBuf,
        can_reuse: impl Fn(&Engine) -> bool,
        load: impl FnOnce(&Path) -> Result<Engine, String>,
        use_engine: impl FnOnce(&mut Engine) -> Result<T, TranscriptionError>,
    ) -> Result<T, TranscriptionError> {
        self.touch_activity();
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
        let result = use_engine(engine);
        self.touch_activity();
        result
    }
}

/// Drain the cache slot under an already-held guard and log who triggered
/// it. Shared by `evict_if_immediate` (synchronous, blocking lock) and the
/// idle watcher (non-blocking `try_lock`). The actual `Drop` of the engine
/// runs when the guard is released by the caller, so the lock is never
/// held across heavy teardown.
fn evict_locked(guard: &mut MutexGuard<'_, Cached>, reason: impl std::fmt::Display) {
    if let Some((path, _engine)) = guard.take() {
        debug!(
            "[Transcription] unloaded model ({}): {}",
            reason,
            path.display()
        );
    }
}

/// Return the idle duration after which the watcher should evict, or `None`
/// if this policy is not driven by the watcher (Never never evicts;
/// Immediately is enforced synchronously after each transcription).
fn idle_timeout_for(policy: UnloadPolicy) -> Option<Duration> {
    match policy {
        UnloadPolicy::Never | UnloadPolicy::Immediately => None,
        UnloadPolicy::AfterMinutes(m) => Some(Duration::from_secs(m * 60)),
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_known_policy_values() {
        assert_eq!(UnloadPolicy::from_wire("never"), UnloadPolicy::Never);
        assert_eq!(
            UnloadPolicy::from_wire("immediately"),
            UnloadPolicy::Immediately
        );
        assert_eq!(
            UnloadPolicy::from_wire("after_5_minutes"),
            UnloadPolicy::AfterMinutes(5)
        );
        assert_eq!(
            UnloadPolicy::from_wire("after_30_minutes"),
            UnloadPolicy::AfterMinutes(30)
        );
    }

    #[test]
    fn unknown_wire_value_falls_back_to_default() {
        assert_eq!(UnloadPolicy::from_wire("after_3_minutes"), UnloadPolicy::DEFAULT);
        assert_eq!(UnloadPolicy::from_wire(""), UnloadPolicy::DEFAULT);
    }

    #[test]
    fn idle_timeout_is_none_for_non_timed_policies() {
        assert!(idle_timeout_for(UnloadPolicy::Never).is_none());
        assert!(idle_timeout_for(UnloadPolicy::Immediately).is_none());
    }

    #[test]
    fn idle_timeout_matches_minutes() {
        assert_eq!(
            idle_timeout_for(UnloadPolicy::AfterMinutes(5)),
            Some(Duration::from_secs(300))
        );
        assert_eq!(
            idle_timeout_for(UnloadPolicy::AfterMinutes(30)),
            Some(Duration::from_secs(1800))
        );
    }

    #[test]
    fn set_policy_updates_current_value() {
        let manager = ModelManager::new();
        assert_eq!(manager.current_policy(), UnloadPolicy::DEFAULT);
        manager.set_policy(UnloadPolicy::Immediately);
        assert_eq!(manager.current_policy(), UnloadPolicy::Immediately);
    }
}
