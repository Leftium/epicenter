use serde::{Deserialize, Serialize};
use tauri::State;

use super::keys::KeyBinding;
use super::{DictationCapability, KeyboardListener};

/// The current dictation capability: whether Whispering can tap the keyboard for
/// global shortcuts and paste back. The FE seeds from this on attach, then
/// tracks `DictationCapabilityEvent` for changes; it never probes the OS itself.
/// The Rust supervisor owns the value and the tap's lifecycle, so there is no
/// `start` command for the FE to call.
#[tauri::command]
#[specta::specta]
pub fn get_dictation_capability(listener: State<'_, KeyboardListener>) -> DictationCapability {
    listener.capability()
}

/// One command's binding, as sent from the FE registrar. `command_id` is the
/// id the trigger event is emitted under; the FE filters by that command's `on`
/// array and dispatches the callback.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CommandBinding {
    pub command_id: String,
    pub binding: KeyBinding,
}

/// Replace the full set of registered global shortcuts. The FE computes the
/// complete list from device-config and pushes it on startup and on every
/// change; the listener swaps its binding set atomically. Replace-all (not
/// per-command register/unregister) keeps the FE the single source of truth for
/// what is bound, with no add/remove bookkeeping to drift.
#[tauri::command]
#[specta::specta]
pub fn set_keyboard_shortcuts(
    listener: State<'_, KeyboardListener>,
    bindings: Vec<CommandBinding>,
) {
    listener.set_bindings(
        bindings
            .into_iter()
            .map(|b| (b.command_id, b.binding))
            .collect(),
    );
}

/// Tell the keyboard supervisor whether auto-paste-at-cursor is enabled. Paste
/// writes a synthetic Cmd/Ctrl+V through the same macOS Accessibility grant the
/// tap reads through, so the supervisor holds the tap whenever paste is on (even
/// with no binding) to track that grant and surface the notice when it is
/// missing. The FE pushes this on startup and whenever the output settings change.
#[tauri::command]
#[specta::specta]
pub fn set_auto_paste_enabled(listener: State<'_, KeyboardListener>, enabled: bool) {
    listener.set_auto_paste_enabled(enabled);
}

/// Enter or leave binding-capture mode for the settings recorder. While
/// capturing, the listener emits the held combo as a `ShortcutCaptureEvent`
/// (which the recorder accumulates) instead of firing command triggers, so the
/// user can record Fn and physical-key bindings the webview cannot see.
#[tauri::command]
#[specta::specta]
pub fn set_keyboard_capturing(listener: State<'_, KeyboardListener>, capturing: bool) {
    listener.set_capturing(capturing);
}
