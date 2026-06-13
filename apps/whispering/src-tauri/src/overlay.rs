//! macOS-only: the recording overlay as a non-activating `NSPanel`.
//!
//! A plain always-on-top `WebviewWindow` still activates the app when clicked:
//! `focusable: false` only blocks keyboard focus, not application activation.
//! That would yank the main window forward every time the user clicks
//! stop/cancel on the overlay while dictating into another app. An `NSPanel`
//! with `can_become_key_window: false` never activates the app, so the
//! overlay's buttons work without stealing focus or raising the main window.
//!
//! The panel is created hidden at startup and registered under the same
//! `recording-overlay` label the JS window manager looks up, so the frontend
//! drives show/hide/position/levels exactly as it does for the plain
//! `WebviewWindow` on other platforms (the manager already prefers an existing
//! window via `getByLabel` before creating one).

// `Manager` is needed in scope because the `tauri_panel!` macro expands to code
// that calls `.app_handle()` on the window.
use tauri::{AppHandle, Manager, WebviewUrl};
use tauri_nspanel::{tauri_panel, CollectionBehavior, PanelBuilder, PanelLevel};

// Must stay in sync with the JS window manager's `WINDOW_LABEL` and the pill's
// size in `src/lib/recording-overlay/`.
const WINDOW_LABEL: &str = "recording-overlay";
const OVERLAY_WIDTH: f64 = 184.0;
const OVERLAY_HEIGHT: f64 = 40.0;

tauri_panel! {
    panel!(RecordingOverlayPanel {
        config: {
            can_become_key_window: false,
            is_floating_panel: true
        }
    })
}

/// Create the recording overlay panel, hidden. The frontend repositions and
/// shows it once recording starts, so the initial position here is unused.
pub fn create_recording_overlay(app: &AppHandle) {
    let result = PanelBuilder::<_, RecordingOverlayPanel>::new(app, WINDOW_LABEL)
        .url(WebviewUrl::App("recording-overlay".into()))
        .title("Recording")
        .position(tauri::Position::Logical(tauri::LogicalPosition {
            x: 0.0,
            y: 0.0,
        }))
        .size(tauri::Size::Logical(tauri::LogicalSize {
            width: OVERLAY_WIDTH,
            height: OVERLAY_HEIGHT,
        }))
        .level(PanelLevel::Status)
        .has_shadow(false)
        .transparent(true)
        .no_activate(true)
        .corner_radius(0.0)
        .with_window(|w| w.decorations(false).transparent(true))
        .collection_behavior(
            CollectionBehavior::new()
                .can_join_all_spaces()
                .full_screen_auxiliary(),
        )
        .build();

    match result {
        Ok(panel) => {
            let _ = panel.hide();
        }
        Err(e) => {
            log::error!("Failed to create recording overlay panel: {e}");
        }
    }
}
