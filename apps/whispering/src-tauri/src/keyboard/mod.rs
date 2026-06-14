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
//! Wave 2 builds this module in isolation; the FE registrar swap, the register
//! commands, and starting the listener at launch land in Wave 3.

pub mod event;
pub mod keys;
pub mod matcher;
mod rdev_map;

pub use event::{ShortcutTriggerEvent, TriggerState, EVENT_CHANNEL};
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
                    let triggers = match matcher.lock() {
                        Ok(mut matcher) => matcher.on_event(edge, input),
                        Err(_) => return,
                    };
                    for trigger in triggers {
                        let _ = app.emit(EVENT_CHANNEL, trigger);
                    }
                });
                if let Err(error) = result {
                    log::error!("rdev keyboard listener stopped: {error:?}");
                }
            })
            .expect("failed to spawn rdev keyboard listener thread");
    }
}
