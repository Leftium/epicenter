use super::config::Engine;
use serde::Serialize;

/// Channel name for every model lifecycle event. A single channel keeps the
/// FE listener trivial: one `listen<ModelStateEvent>(EVENT_CHANNEL, ...)`
/// covers loading, completion, failure, unload, and selection change.
pub const EVENT_CHANNEL: &str = "transcription://model-state";

/// Snapshot of everything observable about the resident model. Every event
/// carries a full snapshot rather than a delta because `AppHandle::emit`
/// does not replay to future windows: a window opened mid-load reads the
/// current snapshot via `get_transcription_state` and then catches up via
/// the next event.
#[derive(Debug, Clone, Serialize, specta::Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalModelState {
    pub engine: Option<Engine>,
    pub model_path: Option<String>,
    pub status: ModelStatus,
}

/// Lifecycle state of the resident model. Owned by an `Arc<RwLock<...>>`
/// inside `ModelManager` so `snapshot()` can read it without touching the
/// cache mutex (which is held across long-running inference).
#[derive(Debug, Clone, Serialize, specta::Type, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ModelStatus {
    /// No model resident and none loading. Initial state, and reached after
    /// `Unloaded`.
    Idle,
    /// `with_engine` is currently inside the `load(&model_path)` call.
    Loading,
    /// A model is resident and not currently in use.
    Ready,
    /// `with_engine` is currently inside the user closure (transcribe call).
    /// The cache lock is held; `snapshot()` reports this without contending.
    Inferring,
    /// The last attempt to load or transcribe failed. The cache is empty.
    Error { message: String },
}

/// Reason the resident model was dropped. Folded into a single event variant
/// (`ModelStateEvent::Unloaded`) rather than fanned out into per-reason
/// variants so the FE has one branch to handle.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UnloadReason {
    /// Synchronous eviction after a transcription completed under the
    /// `Immediately` unload policy.
    Immediate,
    /// Background idle watcher dropped the model after the configured timeout
    /// elapsed without activity.
    Idle {
        #[specta(type = u32)]
        idle_secs: u64,
    },
    /// User selected a different model in settings; the old one was dropped
    /// before the new one preloads.
    ConfigChanged,
}

/// Single event type for everything observable about the model lifecycle.
/// `tag = "kind"` matches `ModelStatus` and `UnloadReason` so the FE pattern
/// is uniform: `switch (event.kind)`.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ModelStateEvent {
    LoadingStarted {
        state: LocalModelState,
    },
    LoadingCompleted {
        state: LocalModelState,
        #[specta(type = u32)]
        elapsed_ms: u64,
    },
    LoadingFailed {
        state: LocalModelState,
        error: String,
    },
    Unloaded {
        state: LocalModelState,
        reason: UnloadReason,
    },
    SelectionChanged {
        state: LocalModelState,
    },
}
