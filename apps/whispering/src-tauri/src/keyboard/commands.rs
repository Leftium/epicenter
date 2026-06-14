use serde::{Deserialize, Serialize};
use tauri::State;

use super::keys::KeyBinding;
use super::KeyboardListener;

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
