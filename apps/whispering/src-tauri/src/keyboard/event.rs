use serde::{Deserialize, Serialize};

/// The event every desktop keyboard trigger is emitted on (an `app.emit` topic,
/// not a `tauri::ipc::Channel`). The Rust listener emits here; the FE registrar
/// (`listen<ShortcutTriggerEvent>(...)`, Wave 3) maps each event to
/// `command.callback(state)`. Mirrors the `transcription://model-state`
/// convention.
pub const TRIGGER_EVENT: &str = "keyboard://shortcut-trigger";

/// The event the listener emits the currently-held combo on while the settings
/// recorder is capturing a new binding. Recording goes through rdev (not the
/// webview) because only rdev sees the Fn key and physical-key positions, so
/// the captured binding is exactly what the matcher will later match. The FE
/// accumulates these `KeyBinding` snapshots and commits when all keys release.
pub const CAPTURE_EVENT: &str = "keyboard://shortcut-capture";

/// Whether a binding just became fully held (`Pressed`) or stopped being fully
/// held (`Released`). The variant names serialize verbatim to `"Pressed"` /
/// `"Released"`, which is exactly the `ShortcutEventState` the Tauri
/// global-shortcut plugin used to deliver, so the command layer (`commands.ts`)
/// is unchanged: only the producer of these strings changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub enum TriggerState {
    Pressed,
    Released,
}

/// Emitted on every binding transition. `command_id` is the id the binding was
/// registered under; the FE filters by that command's `on` array and dispatches
/// the callback. Rust stays command-agnostic: it knows the id and the edge, not
/// which states a given command cares about.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutTriggerEvent {
    pub command_id: String,
    pub state: TriggerState,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn trigger_state_serializes_to_the_plugins_pascalcase_strings() {
        // The whole point of matching this wire shape: `commands.ts` keeps
        // comparing against 'Pressed' | 'Released' with no change.
        assert_eq!(
            serde_json::to_value(TriggerState::Pressed).unwrap(),
            json!("Pressed")
        );
        assert_eq!(
            serde_json::to_value(TriggerState::Released).unwrap(),
            json!("Released")
        );
    }

    #[test]
    fn trigger_event_wire_shape_is_camel_case() {
        let event = ShortcutTriggerEvent {
            command_id: "pushToTalk".to_string(),
            state: TriggerState::Pressed,
        };
        assert_eq!(
            serde_json::to_value(event).unwrap(),
            json!({ "commandId": "pushToTalk", "state": "Pressed" })
        );
    }
}
