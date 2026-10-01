//! The Honeycrisp desktop shell.
//!
//! The shell owns three things and no data: it starts the Bun folder host,
//! opens one window on the host's loopback origin, and holds a window close or
//! an application quit back until the page saves or confirms a discard.
//!
//! The page calls no native command. It reaches its notes directory through
//! the host's same-origin `/bridge`, with a token generated here for this
//! launch and placed in the window before any page script runs.
//!
//! Host process contract:
//! - environment: `HONEYCRISP_HOST_TOKEN`, `HONEYCRISP_UI_DIST`,
//!   `HONEYCRISP_SHELL=1`; `HONEYCRISP_ROOT` and the `HONEYCRISP_FAULTS`
//!   family pass through from this process's environment.
//! - stdout line 1: `{"ready":true,"port":<n>,"root":"<path>"}`.
//! - later stdout line: `{"quit":true}` approves closing.
//! - stdin: the line `close-requested` asks the page to settle its drafts;
//!   closing stdin stops the host.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(target_os = "macos")]
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};

const READY_TIMEOUT: Duration = Duration::from_secs(20);

/// The running folder host and the page's explicit permission to quit.
struct Host {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    /// The page may still hold work when its file host stops.
    gone: AtomicBool,
    /// The page agreed to quit; no close request is held back afterward.
    quitting: AtomicBool,
}

impl Host {
    /// Whether a close or quit must wait. When it must, the page is asked to
    /// save its drafts or let the person choose.
    fn hold(&self, app: &AppHandle) -> bool {
        if self.quitting.load(Ordering::SeqCst) {
            return false;
        }
        // Every close needs the page's answer. The shell cannot know whether
        // typing arrived after any earlier observation of the drafts.
        let asked = !self.gone.load(Ordering::SeqCst) && {
            let mut stdin = self.stdin.lock().unwrap();
            match stdin.as_mut() {
                Some(pipe) => writeln!(pipe, "close-requested")
                    .and_then(|()| pipe.flush())
                    .is_ok(),
                None => false,
            }
        };
        if !asked {
            self.gone.store(true, Ordering::SeqCst);
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.eval("window.dispatchEvent(new Event('honeycrisp:close-blocked'));");
            }
        }
        true
    }

    fn stop(&self) {
        self.quitting.store(true, Ordering::SeqCst);
        // Closing stdin is the host's signal to finish and exit.
        self.stdin.lock().unwrap().take();
        if let Some(mut child) = self.child.lock().unwrap().take() {
            // Let folder.close() settle requested commits before terminating.
            let deadline = Instant::now() + Duration::from_secs(5);
            while Instant::now() < deadline {
                match child.try_wait() {
                    Ok(Some(_)) => return,
                    Ok(None) => thread::sleep(Duration::from_millis(25)),
                    Err(_) => break,
                }
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn launch_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| format!("generate the bridge token: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(debug_assertions)]
fn host_command(_app: &AppHandle) -> Result<(Command, PathBuf), String> {
    let app_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or("the src-tauri directory has no parent")?
        .to_path_buf();
    let mut command = Command::new("bun");
    command.current_dir(&app_dir).arg("run").arg("host/main.ts");
    Ok((command, app_dir.join("build-desktop")))
}

#[cfg(not(debug_assertions))]
fn host_command(app: &AppHandle) -> Result<(Command, PathBuf), String> {
    let executable =
        std::env::current_exe().map_err(|error| format!("resolve the executable: {error}"))?;
    let directory = executable
        .parent()
        .ok_or("the executable has no parent directory")?;
    let filename = if cfg!(windows) {
        "honeycrisp-host.exe"
    } else {
        "honeycrisp-host"
    };
    let ui = app
        .path()
        .resource_dir()
        .map_err(|error| format!("resolve the resource directory: {error}"))?
        .join("ui");
    Ok((Command::new(directory.join(filename)), ui))
}

/// Start the host and wait for its ready line. Returns its port.
fn start_host(app: &AppHandle, token: &str) -> Result<u16, String> {
    let (mut command, ui_dist) = host_command(app)?;
    command
        .env("HONEYCRISP_HOST_TOKEN", token)
        .env("HONEYCRISP_UI_DIST", ui_dist)
        .env("HONEYCRISP_SHELL", "1")
        .env_remove("HONEYCRISP_HOST_PAGE_TOKEN")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(if cfg!(debug_assertions) {
            Stdio::inherit()
        } else {
            Stdio::null()
        });
    let mut child = command
        .spawn()
        .map_err(|error| format!("start the notes folder host: {error}"))?;
    let stdin = child.stdin.take().ok_or("capture the host's stdin")?;
    let stdout = child.stdout.take().ok_or("capture the host's stdout")?;

    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        let read = reader.read_line(&mut line).map(|_| line);
        let _ = sender.send((read, reader));
    });
    let (line, reader) = match receiver.recv_timeout(READY_TIMEOUT) {
        Ok((Ok(line), reader)) => (line, reader),
        Ok((Err(error), _)) => {
            let _ = child.kill();
            return Err(format!("read the host's ready line: {error}"));
        }
        Err(_) => {
            let _ = child.kill();
            return Err("the notes folder host did not become ready in 20 seconds".into());
        }
    };
    let ready: serde_json::Value = serde_json::from_str(line.trim()).map_err(|_| {
        let _ = child.kill();
        format!("the notes folder host did not start: {}", line.trim())
    })?;
    let port = ready
        .get("port")
        .and_then(serde_json::Value::as_u64)
        .and_then(|port| u16::try_from(port).ok())
        .ok_or("the host's ready line has no port")?;

    app.manage(Host {
        child: Mutex::new(Some(child)),
        stdin: Mutex::new(Some(stdin)),
        gone: AtomicBool::new(false),
        quitting: AtomicBool::new(false),
    });

    // Follow what the page reports through the host for the rest of the run.
    let handle = app.clone();
    thread::spawn(move || {
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let Ok(message) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            let host = handle.state::<Host>();
            if message.get("quit").and_then(serde_json::Value::as_bool) == Some(true) {
                host.quitting.store(true, Ordering::SeqCst);
                handle.exit(0);
            }
        }
        // Host failure is not permission to discard work in the page.
        let host = handle.state::<Host>();
        host.gone.store(true, Ordering::SeqCst);
        if !host.quitting.load(Ordering::SeqCst) {
            eprintln!("The Honeycrisp folder host stopped; keeping the window's drafts.");
        }
    });

    Ok(port)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "quit-notes" {
                if let Some(host) = app.try_state::<Host>() {
                    if host.hold(app) {
                        return;
                    }
                }
                app.exit(0);
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            #[cfg(target_os = "macos")]
            {
                // The predefined macOS Quit item calls Cocoa's terminate:
                // directly, bypassing the preventable Tauri exit request.
                let menu = Menu::default(&handle)?;
                let quit = MenuItem::with_id(
                    &handle, "quit-notes", "Quit Honeycrisp", true, Some("CmdOrCtrl+Q"),
                )?;
                let app_menu = Submenu::with_items(&handle, "Honeycrisp", true, &[
                    &PredefinedMenuItem::about(&handle, None, None)?,
                    &PredefinedMenuItem::separator(&handle)?,
                    &PredefinedMenuItem::services(&handle, None)?,
                    &PredefinedMenuItem::separator(&handle)?,
                    &PredefinedMenuItem::hide(&handle, None)?,
                    &PredefinedMenuItem::hide_others(&handle, None)?,
                    &PredefinedMenuItem::separator(&handle)?,
                    &quit,
                ])?;
                menu.remove_at(0)?;
                menu.insert(&app_menu, 0)?;
                app.set_menu(menu)?;
            }
            let token = launch_token()?;
            let port = start_host(&handle, &token)?;
            let origin = format!("http://127.0.0.1:{port}");
            let url: Url = format!("{origin}/").parse()?;
            // The token exists only in a page from the host's own origin.
            let script = format!(
                "if (location.origin === {origin}) {{ Object.defineProperty(window, '__HONEYCRISP_BRIDGE__', {{ value: Object.freeze({{ token: {token} }}) }}); }}",
                origin = serde_json::to_string(&origin)?,
                token = serde_json::to_string(&token)?,
            );
            let allowed = origin.clone();
            let navigation_handle = handle.clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Honeycrisp")
                .inner_size(1280.0, 820.0)
                .min_inner_size(900.0, 560.0)
                .initialization_script(&script)
                // The window shows the notes page and nothing else.
                .on_navigation(move |target| {
                    if target.origin().ascii_serialization() != allowed {
                        return false;
                    }
                    // With no host, the page's explicit discard choice needs
                    // a path to the shell. Never load this control address.
                    if target.path() == "/__honeycrisp__/quit" {
                        let host = navigation_handle.state::<Host>();
                        if host.gone.load(Ordering::SeqCst) {
                            host.quitting.store(true, Ordering::SeqCst);
                            navigation_handle.exit(0);
                        }
                        return false;
                    }
                    true
                })
                .build()?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if let Some(host) = window.try_state::<Host>() {
                    if host.hold(window.app_handle()) {
                        api.prevent_close();
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the Honeycrisp application");

    app.run(|handle, event| match event {
        // Runtime exit requests need the same page acknowledgment as closing
        // the window. The macOS menu is routed explicitly above.
        RunEvent::ExitRequested { api, .. } => {
            if let Some(host) = handle.try_state::<Host>() {
                if host.hold(handle) {
                    api.prevent_exit();
                }
            }
        }
        RunEvent::Exit => {
            if let Some(host) = handle.try_state::<Host>() {
                host.stop();
            }
        }
        _ => {}
    });
}
