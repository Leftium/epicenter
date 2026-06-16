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
//! Wiring: the `set_keyboard_shortcuts` command pushes the user's bindings and
//! the FE registrar dispatches the emitted events. A Rust-owned supervisor (see
//! `run_supervisor`) owns the tap's whole lifecycle: it gates spawning on the
//! live macOS Accessibility trust (`AXIsProcessTrusted`), restarts a tap that
//! dies under a held grant, and publishes the resulting `DictationCapability` so
//! the frontend is a pure view over one value instead of inferring liveness and
//! polling trust itself. The trust fact belongs to the process that holds the
//! tap; that is this one, so this is where it lives.

pub mod commands;
pub mod event;
pub mod keys;
pub mod matcher;
mod rdev_map;

pub use event::{
    DictationCapability, DictationCapabilityEvent, ShortcutCaptureEvent, ShortcutTriggerEvent,
    TriggerState,
};
pub use keys::{Key, KeyBinding, Modifier};

use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::AppHandle;
use tauri_specta::Event;

use matcher::{Edge, Matcher};

/// The window the trigger/capture events are delivered to. We target it
/// explicitly instead of broadcasting so the overlay and picker webviews never
/// see shortcut events, which keeps the dispatch single even if they subscribe.
const MAIN_WINDOW: &str = "main";

/// Backoff for a tap that dies while the grant still holds, so a genuinely
/// broken tap cannot hot-loop. After the last step the supervisor gives up to
/// `Broken`. A death more than `RESTART_RESET_WINDOW` after the previous one
/// starts with a fresh budget, because there is no positive "stayed alive"
/// signal to reset on.
const RESTART_BACKOFF_MS: [u64; 5] = [1_000, 2_000, 4_000, 8_000, 16_000];
const RESTART_RESET_WINDOW: Duration = Duration::from_secs(60);

/// How often the supervisor re-checks `AXIsProcessTrusted` while it is waiting
/// for the grant. It runs ONLY while the capability is not `Active`, so it is
/// never a steady-state poll: once the tap is running there is nothing to poll
/// (the tap reports its own death over the channel). macOS gives no event when
/// Accessibility flips, so this bounded re-check is the one unavoidable poll,
/// and it lives in Rust beside the tap rather than in the webview.
const TRUST_POLL_INTERVAL: Duration = Duration::from_secs(1);

/// rdev's listener is X11-only; on Wayland the tap never receives events.
#[cfg(target_os = "linux")]
fn is_wayland() -> bool {
    std::env::var("XDG_SESSION_TYPE")
        .map(|value| value.eq_ignore_ascii_case("wayland"))
        .unwrap_or(false)
        || std::env::var("WAYLAND_DISPLAY").is_ok()
}

/// Whether this process may currently tap the keyboard. On macOS this is the
/// live Accessibility check (`AXIsProcessTrusted`); every other desktop has no
/// such gate, so the tap is always allowed.
fn is_trusted() -> bool {
    #[cfg(target_os = "macos")]
    {
        // SAFETY: `AXIsProcessTrusted` is an argument-free, thread-safe TCC query
        // with no side effects (unlike the `WithOptions` form, it never prompts).
        unsafe { accessibility_sys::AXIsProcessTrusted() }
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// Owns the registered bindings and the current dictation capability. The tap
/// thread itself is owned by a supervisor spawned in `new` (see
/// `run_supervisor`); this struct is the command-facing handle, constructed in
/// `setup` and managed via `app.manage(...)` so commands reach it with
/// `app.state::<...>()`.
pub struct KeyboardListener {
    matcher: Arc<Mutex<Matcher>>,
    capability: Arc<Mutex<DictationCapability>>,
}

impl KeyboardListener {
    pub fn new(app: AppHandle) -> Self {
        let matcher = Arc::new(Mutex::new(Matcher::new()));
        let capability = Arc::new(Mutex::new(DictationCapability::Unknown));
        spawn_supervisor(app, matcher.clone(), capability.clone());
        Self {
            matcher,
            capability,
        }
    }

    /// Replace the full set of registered bindings. Called from the FE registrar
    /// whenever the user's configured global shortcuts change. Poisoned lock is
    /// swallowed: a panicked matcher thread should not take the app down.
    pub fn set_bindings(&self, bindings: Vec<(String, KeyBinding)>) {
        if let Ok(mut matcher) = self.matcher.lock() {
            matcher.set_bindings(bindings);
        }
    }

    /// Enter or leave capture mode. While capturing, the tap forwards the held
    /// combo to the settings recorder as a `ShortcutCaptureEvent` instead of
    /// matching registered bindings (see `Matcher::set_capturing`).
    pub fn set_capturing(&self, capturing: bool) {
        if let Ok(mut matcher) = self.matcher.lock() {
            matcher.set_capturing(capturing);
        }
    }

    /// The current dictation capability, for the FE's seed on attach.
    pub fn capability(&self) -> DictationCapability {
        self.capability
            .lock()
            .map(|c| *c)
            .unwrap_or(DictationCapability::Unknown)
    }
}

/// Store the new capability and, if it changed, push it to the frontend. The
/// supervisor is the only writer, so the compare-and-emit needs no extra
/// synchronization beyond the cell's own lock.
fn set_capability(app: &AppHandle, cell: &Arc<Mutex<DictationCapability>>, next: DictationCapability) {
    if let Ok(mut current) = cell.lock() {
        if *current == next {
            return;
        }
        *current = next;
    }
    let _ = DictationCapabilityEvent { capability: next }.emit_to(app, MAIN_WINDOW);
}

/// Spawn one rdev tap thread. It runs until `rdev::listen` returns (a tap break,
/// a revoked grant, or a stale signature), then reports its exit over `stop_tx`.
/// `listen` is a passive tap (not `grab`, so keystrokes still reach the
/// foreground app). The supervisor is the only caller and serializes spawns, so
/// there is no running-guard: exactly one tap thread is ever live at a time.
fn spawn_listener(app: &AppHandle, matcher: &Arc<Mutex<Matcher>>, stop_tx: &Sender<Option<String>>) {
    let app = app.clone();
    let matcher = matcher.clone();
    let stop_tx = stop_tx.clone();
    std::thread::Builder::new()
        .name("rdev-keyboard-listener".into())
        .spawn(move || {
            // A previous tap that exited may have left a key in the held set with
            // no matching release; start clean so a stale modifier cannot wedge a
            // binding "down" under exact-set matching.
            if let Ok(mut matcher) = matcher.lock() {
                matcher.clear_held();
            }

            // `rdev::listen` moves `app`/`matcher` into its callback.
            let matcher_cb = matcher.clone();
            let result = rdev::listen(move |event| {
                let (edge, key) = match event.event_type {
                    rdev::EventType::KeyPress(key) => (Edge::Press, key),
                    rdev::EventType::KeyRelease(key) => (Edge::Release, key),
                    _ => return,
                };
                let Some(input) = rdev_map::classify(key) else {
                    return;
                };

                // Hold the lock only to resolve the event; emit after dropping it
                // so a subscriber callback can never deadlock the tap.
                let triggers = {
                    let Ok(mut matcher) = matcher_cb.lock() else {
                        return;
                    };
                    let triggers = matcher.on_event(edge, input);
                    // In capture mode the recorder wants the live held combo, not
                    // command triggers (which `on_event` suppresses).
                    if matcher.is_capturing() {
                        let binding = matcher.held_binding();
                        drop(matcher);
                        let _ = ShortcutCaptureEvent { binding }.emit_to(&app, MAIN_WINDOW);
                        return;
                    }
                    triggers
                };

                for trigger in triggers {
                    let _ = trigger.emit_to(&app, MAIN_WINDOW);
                }
            });
            let reason = result.err().map(|error| format!("{error:?}"));
            if let Some(reason) = &reason {
                log::error!("rdev keyboard listener stopped: {reason}");
            }
            // Hand the exit to the supervisor, which decides what it means
            // (revoked grant vs transient death vs stale signature) and whether
            // to restart. The reason rides along for the log only.
            let _ = stop_tx.send(reason);
        })
        .expect("failed to spawn rdev keyboard listener thread");
}

fn spawn_supervisor(
    app: AppHandle,
    matcher: Arc<Mutex<Matcher>>,
    capability: Arc<Mutex<DictationCapability>>,
) {
    std::thread::Builder::new()
        .name("dictation-capability-supervisor".into())
        .spawn(move || run_supervisor(app, matcher, capability))
        .expect("failed to spawn dictation capability supervisor thread");
}

/// What woke the supervisor on a given loop turn.
enum Signal {
    /// The tap thread exited; the payload is its debug-formatted reason (log only).
    Stopped(Option<String>),
    /// The trust poll fired while waiting for the grant.
    Poll,
    /// The channel closed (app teardown). End the supervisor.
    Shutdown,
}

/// The single owner of the tap's lifecycle and the published `DictationCapability`.
///
/// The two hard facts it designs around: `rdev::listen` gives a thread-death
/// signal but no positive "alive" signal, and macOS gives no event when
/// Accessibility flips. So the tap is spawned only while trusted (an untrusted
/// `listen` silently drops events, looking alive), its liveness is the death
/// channel, and the grant is sampled by a bounded poll that runs only while we
/// are NOT already running. All of that lives here, beside the tap, instead of
/// being smeared across the webview.
fn run_supervisor(
    app: AppHandle,
    matcher: Arc<Mutex<Matcher>>,
    capability: Arc<Mutex<DictationCapability>>,
) {
    #[cfg(target_os = "linux")]
    if is_wayland() {
        set_capability(&app, &capability, DictationCapability::Unsupported);
        return;
    }

    let (stop_tx, stop_rx) = mpsc::channel::<Option<String>>();
    let mut restart_attempt = 0usize;
    let mut last_stop: Option<Instant> = None;

    // Reconcile to the live grant: start now if trusted, else wait for it.
    let mut phase = if is_trusted() {
        spawn_listener(&app, &matcher, &stop_tx);
        DictationCapability::Active
    } else {
        DictationCapability::Untrusted
    };
    set_capability(&app, &capability, phase);

    loop {
        // `Active`: block until the tap dies. Otherwise poll the grant so a
        // toggle in System Settings (which fires no event) is caught.
        let signal = match phase {
            DictationCapability::Active => match stop_rx.recv() {
                Ok(reason) => Signal::Stopped(reason),
                Err(_) => Signal::Shutdown,
            },
            _ => match stop_rx.recv_timeout(TRUST_POLL_INTERVAL) {
                Ok(reason) => Signal::Stopped(reason),
                Err(RecvTimeoutError::Timeout) => Signal::Poll,
                Err(RecvTimeoutError::Disconnected) => Signal::Shutdown,
            },
        };

        match signal {
            Signal::Shutdown => return,

            // Waiting for the grant. `Untrusted` -> trust returned, so start.
            // `Broken` -> we are watching for the remove (a trust drop) that
            // precedes a re-add; a still-trusted stale grant must not respawn,
            // because the tap would just die again.
            Signal::Poll => {
                if is_trusted() {
                    if phase == DictationCapability::Untrusted {
                        spawn_listener(&app, &matcher, &stop_tx);
                        restart_attempt = 0;
                        phase = DictationCapability::Active;
                    }
                } else {
                    restart_attempt = 0;
                    phase = DictationCapability::Untrusted;
                }
            }

            // The tap exited. A vanished grant drops us to `Untrusted` (the next
            // grant respawns); a grant that still holds is an unexpected death,
            // so restart with capped backoff and, once spent, settle on `Broken`.
            Signal::Stopped(_reason) => {
                if !is_trusted() {
                    restart_attempt = 0;
                    phase = DictationCapability::Untrusted;
                } else {
                    let now = Instant::now();
                    if last_stop.is_some_and(|t| now.duration_since(t) > RESTART_RESET_WINDOW) {
                        restart_attempt = 0;
                    }
                    last_stop = Some(now);
                    if restart_attempt >= RESTART_BACKOFF_MS.len() {
                        phase = DictationCapability::Broken;
                    } else {
                        let delay = RESTART_BACKOFF_MS[restart_attempt];
                        restart_attempt += 1;
                        std::thread::sleep(Duration::from_millis(delay));
                        spawn_listener(&app, &matcher, &stop_tx);
                        // Stay `Active` across a transient restart: no user-facing flap.
                        phase = DictationCapability::Active;
                    }
                }
            }
        }

        set_capability(&app, &capability, phase);
    }
}
