//! Capture's page owns its drafts. Ask it before quitting the desktop host.
//! Closing its window hides it, so only process exit needs this handshake.

use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

#[derive(Default)]
pub struct CaptureLifetime(Mutex<QuitState>);

#[derive(Default)]
struct QuitState {
    next: u64,
    pending: Option<(u64, bool, i32)>,
    approved: bool,
}

/// Only the Capture window may answer its current quit request.
#[tauri::command]
pub fn capture_quit_answer(
    window: WebviewWindow,
    state: State<'_, CaptureLifetime>,
    request_id: u64,
    answer: String,
) -> Result<(), String> {
    if window.label() != "capture" {
        return Err("Only Capture may answer this quit request.".into());
    }
    let mut quit = state
        .0
        .lock()
        .map_err(|_| "Capture quit state is unavailable.")?;
    let Some((current, _, code)) = quit.pending else {
        return Err("The quit request is no longer active.".into());
    };
    if current != request_id {
        return Err("The quit request changed.".into());
    }
    match answer.as_str() {
        "asking" => quit.pending = Some((current, true, code)),
        "cancel" => quit.pending = None,
        "proceed" => {
            quit.pending = None;
            quit.approved = true;
            drop(quit);
            window.app_handle().exit(code);
        }
        _ => return Err("Unknown Capture quit answer.".into()),
    }
    Ok(())
}

/// Returns true when this exit must wait for Capture or an explicit discard.
pub fn request_quit(app: &AppHandle, code: i32) -> bool {
    let Some(window) = app.get_webview_window("capture") else {
        return false;
    };
    let state = app.state::<CaptureLifetime>();
    let Ok(mut quit) = state.0.lock() else {
        return true;
    };
    if quit.approved {
        return false;
    }
    if quit.pending.is_some() {
        let _ = window.show();
        let _ = window.set_focus();
        return true;
    }
    quit.next += 1;
    let request_id = quit.next;
    quit.pending = Some((request_id, false, code));
    drop(quit);
    let _ = window.show();
    let _ = window.set_focus();
    let _ = window.emit("capture-quit-requested", request_id);

    // A page which never mounted, or cannot answer, must not trap the host.
    // Silence is not permission: only a person's explicit discard permits exit.
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(3));
        let state = app.state::<CaptureLifetime>();
        let unanswered = state
            .0
            .lock()
            .is_ok_and(|quit| quit.pending == Some((request_id, false, code)));
        if !unanswered {
            return;
        }
        let replying = app.clone();
        app.dialog()
            .message("Capture could not confirm that its drafts are saved. Keep Epicenter open to recover them, or discard them and quit.")
            .title("Capture has not answered")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom("Discard and quit".into(), "Keep open".into()))
            .show(move |discard| {
                let state = replying.state::<CaptureLifetime>();
                let Ok(mut quit) = state.0.lock() else { return };
                if quit.pending != Some((request_id, false, code)) {
                    return;
                }
                quit.pending = None;
                if discard {
                    quit.approved = true;
                    drop(quit);
                    replying.exit(code);
                }
            });
    });
    true
}

/// A dead sidecar cannot save a draft. Keep the page alive for copying it.
pub fn host_stopped(window: &WebviewWindow) {
    let _ = window.emit("capture-host-stopped", ());
    let _ = window.show();
}

/// AppKit's predefined Quit calls terminate: and bypasses ExitRequested.
/// Keep the default menu, but route its Quit item and accelerator through Tauri.
#[cfg(target_os = "macos")]
pub fn menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};

    let menu = Menu::default(app)?;
    let quit_text = PredefinedMenuItem::quit(app, None)?.text()?;
    for item in menu.items()? {
        let Some(submenu) = item.as_submenu() else {
            continue;
        };
        for (position, child) in submenu.items()?.into_iter().enumerate() {
            let Some(predefined) = child.as_predefined_menuitem() else {
                continue;
            };
            if predefined.text()? != quit_text {
                continue;
            }
            submenu.remove_at(position)?;
            submenu.insert(
                &MenuItem::with_id(app, QUIT_MENU_ID, &quit_text, true, Some("CmdOrCtrl+Q"))?,
                position,
            )?;
            return Ok(menu);
        }
    }
    Err(anyhow::anyhow!("The desktop menu has no Quit item to protect Capture drafts.").into())
}

#[cfg(target_os = "macos")]
pub const QUIT_MENU_ID: &str = "epicenter-quit";
