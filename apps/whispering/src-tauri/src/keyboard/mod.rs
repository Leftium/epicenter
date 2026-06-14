//! Desktop global keyboard trigger backend.
//!
//! A single low-level `rdev::listen` hook sees every key down/up system-wide,
//! including the Fn key and modifier-only chords that the Tauri
//! global-shortcut plugin cannot. The pure `matcher` turns that event stream
//! into `{ commandId, state }` transitions that the FE registrar feeds into the
//! existing command layer (`commands.ts`), which is unchanged.
//!
//! Layering, so the complex part stays testable:
//! - `keys`     the binding model (our own `Modifier` / `Key`, physical-key space)
//! - `matcher`  held-set tracking and press/release transitions (pure, unit-tested)
//! - `rdev_map` the only rdev-coupled code: `rdev::Key` -> matcher `Input`
//! - `event`    the wire payload emitted to the FE
//!
//! Wave 2 built this module in isolation. Wave 3 wires it in: the
//! `set_keyboard_shortcuts` command pushes the user's bindings, the listener
//! starts at launch, and the FE registrar dispatches the emitted events.

pub mod commands;
pub mod event;
pub mod keys;
pub mod matcher;
mod rdev_map;

pub use event::{ShortcutTriggerEvent, TriggerState, CAPTURE_EVENT, TRIGGER_EVENT};
pub use keys::{Key, KeyBinding, Modifier};

use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter};

use matcher::{Edge, Matcher};

/// Owns the registered bindings and the rdev listener thread. Constructed in
/// `setup` with an `AppHandle` (mirrors `ModelManager`) and managed via
/// `app.manage(...)` so commands can reach it with `app.state::<...>()`.
pub struct KeyboardListener {
    app: AppHandle,
    matcher: Arc<Mutex<Matcher>>,
}

impl KeyboardListener {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            matcher: Arc::new(Mutex::new(Matcher::new())),
        }
    }

    /// Replace the full set of registered bindings. Called from the FE registrar
    /// (Wave 3) whenever the user's configured global shortcuts change. Poisoned
    /// lock is swallowed: a panicked matcher thread should not take the app down.
    pub fn set_bindings(&self, bindings: Vec<(String, KeyBinding)>) {
        if let Ok(mut matcher) = self.matcher.lock() {
            matcher.set_bindings(bindings);
        }
    }

    /// Enter or leave capture mode. While capturing, the listener forwards the
    /// held combo to the settings recorder on `CAPTURE_EVENT` instead of
    /// matching registered bindings (see `Matcher::set_capturing`).
    pub fn set_capturing(&self, capturing: bool) {
        if let Ok(mut matcher) = self.matcher.lock() {
            matcher.set_capturing(capturing);
        }
    }

    /// Spawn the rdev listener on its own thread. `rdev::listen` blocks for the
    /// process lifetime, so it cannot run on the main thread. It is a passive
    /// **listen** (not `grab`), so keystrokes still reach the foreground app.
    ///
    /// macOS requires Accessibility / Input Monitoring for the tap to receive
    /// events; that permission is wired in Wave 6. Until then `listen` returns
    /// an error here, which we log rather than panic on.
    pub fn start(&self) {
        let app = self.app.clone();
        let matcher = self.matcher.clone();
        std::thread::Builder::new()
            .name("rdev-keyboard-listener".into())
            .spawn(move || {
                let result = rdev::listen(move |event| {
                    let (edge, key) = match event.event_type {
                        rdev::EventType::KeyPress(key) => (Edge::Press, key),
                        rdev::EventType::KeyRelease(key) => (Edge::Release, key),
                        _ => return,
                    };
                    let Some(input) = rdev_map::classify(key) else {
                        return;
                    };
                    let Ok(mut matcher) = matcher.lock() else {
                        return;
                    };
                    let triggers = matcher.on_event(edge, input);
                    // In capture mode the recorder wants the live held combo, not
                    // command triggers (which `on_event` suppresses anyway).
                    if matcher.is_capturing() {
                        let binding = matcher.held_binding();
                        drop(matcher);
                        let _ = app.emit(CAPTURE_EVENT, binding);
                    } else {
                        drop(matcher);
                        for trigger in triggers {
                            let _ = app.emit(TRIGGER_EVENT, trigger);
                        }
                    }
                });
                if let Err(error) = result {
                    log::error!("rdev keyboard listener stopped: {error:?}");
                }
            })
            .expect("failed to spawn rdev keyboard listener thread");
    }
}
