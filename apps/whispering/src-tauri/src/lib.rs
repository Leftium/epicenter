//! The Whispering desktop shell.
//!
//! The shell owns a window and one child process. The child is the Bun folder
//! host (`native/main.ts`): it opens the data folder, serves the page, and
//! answers the page's folder calls on loopback. The shell starts it, waits for
//! the port it reports, loads the page from it, and stops it on exit. The page
//! calls no Tauri command, so this crate registers none.
//!
//! Work that is not saved yet lives only in the page, so the shell never closes
//! on its own judgement. A window close, Command-Q, or any other exit request
//! is held back and turned into a question: the shell writes a close request to
//! the host's standard input, the host asks the page, and the host prints an
//! approval line when the window may close.
//!
//! A host that has stopped approves nothing: the page still holds its unsaved
//! work. The shell then keeps the window, raises an event in the page, and
//! exits only when the page navigates to the quit address, which the shell
//! refuses to load and reads as the person's choice to quit. The one exit
//! without any answer is when no app page was ever opened.
//!
//! A debug shell tells the host it may use fixture audio and failure
//! injection. A release shell never does, whatever the environment says.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{
    App, AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

const READY_TIMEOUT: Duration = Duration::from_secs(20);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
/// What the shell writes to the host's standard input to ask whether it may close.
const CLOSE_REQUEST: &str = "{\"type\":\"close-requested\"}";
#[cfg(target_os = "macos")]
const QUIT_MENU_ID: &str = "quit";

/// The running folder host. Its standard input is held open for as long as the
/// shell lives; the host stops when that pipe closes.
struct HostProcess {
    child: Child,
    stdin: Option<ChildStdin>,
}

/// Raised in the page when a close was attempted and the host could not be
/// asked. The page keeps the window and explains (`src/lib/workspace/desktop.ts`).
const CLOSE_BLOCKED_SCRIPT: &str = "window.dispatchEvent(new Event('whispering:close-blocked'));";
/// The address the page navigates to, once the host is gone, to say "quit".
/// The shell never loads it.
const QUIT_PATH: &str = "/__whispering__/quit";

#[derive(Default)]
struct HostState {
    process: Mutex<Option<HostProcess>>,
    /// Set only by an explicit answer: the page's approval relayed by the host,
    /// the page's own quit signal once the host is gone, or a close before any
    /// page was opened. A host that stopped is never an approval.
    close_approved: AtomicBool,
    /// The host's output ended or it no longer accepts a request.
    host_gone: AtomicBool,
    /// The app page was opened, so unsaved work may exist in it.
    page_opened: AtomicBool,
}

pub fn run() {
    tauri::Builder::default()
        .manage(HostState::default())
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                if !close_is_approved(app) {
                    api.prevent_close();
                    request_close(app);
                }
            }
        })
        .setup(|app| {
            #[cfg(target_os = "macos")]
            install_menu(app)?;
            match start_host(app) {
                Ok(started) => open_app_window(app, started.port, &started.token)?,
                Err(error) => {
                    eprintln!("[whispering] could not start the folder host: {error}");
                    open_failure_window(app, &error)?;
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Whispering")
        .run(|app, event| match event {
            // Command-Q, the Dock, and a system shutdown all arrive here.
            RunEvent::ExitRequested { api, .. } => {
                if !close_is_approved(app) {
                    api.prevent_exit();
                    request_close(app);
                }
            }
            RunEvent::Exit => stop_host(app),
            _ => {}
        });
}

/// The default macOS menu's Quit item can end the process without asking. This
/// menu's Quit goes through the same close request as the window, and keeps
/// the Edit and Window items a text field and a window need.
#[cfg(target_os = "macos")]
fn install_menu(app: &App) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};

    let quit = MenuItemBuilder::with_id(QUIT_MENU_ID, "Quit Whispering")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;
    let app_menu = SubmenuBuilder::new(app, "Whispering").item(&quit).build()?;
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .close_window()
        .build()?;
    let menu = MenuBuilder::new(app)
        .item(&app_menu)
        .item(&edit_menu)
        .item(&window_menu)
        .build()?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        if event.id().as_ref() == QUIT_MENU_ID {
            request_close(app);
        }
    });
    Ok(())
}

fn close_is_approved(app: &AppHandle) -> bool {
    app.state::<HostState>()
        .close_approved
        .load(Ordering::SeqCst)
}

/// What a close request does when the host cannot relay it.
#[derive(Debug, PartialEq, Eq)]
enum WithoutHost {
    /// No app page was ever opened, so nothing unsaved exists anywhere.
    Exit,
    /// A page is open and may hold unsaved work: keep the window and tell it.
    KeepWindowAndTellPage,
}

fn without_host(page_opened: bool) -> WithoutHost {
    if page_opened {
        WithoutHost::KeepWindowAndTellPage
    } else {
        WithoutHost::Exit
    }
}

/// Ask the page, through the host, whether the shell may close.
///
/// A host that is gone approves nothing. The page still holds whatever was not
/// saved, so the window stays and the page is told a close was attempted; it
/// shows its own confirmation and answers with the quit address. Only when no
/// page was ever opened (the host never started) does the shell exit directly.
fn request_close(app: &AppHandle) {
    let state = app.state::<HostState>();
    if state.close_approved.load(Ordering::SeqCst) {
        app.exit(0);
        return;
    }
    let asked = !state.host_gone.load(Ordering::SeqCst) && {
        let mut process = state.process.lock().expect("host state lock poisoned");
        match process.as_mut().and_then(|host| host.stdin.as_mut()) {
            Some(stdin) => writeln!(stdin, "{CLOSE_REQUEST}")
                .and_then(|()| stdin.flush())
                .is_ok(),
            None => false,
        }
    };
    if asked {
        return;
    }
    state.host_gone.store(true, Ordering::SeqCst);
    match without_host(state.page_opened.load(Ordering::SeqCst)) {
        WithoutHost::Exit => {
            state.close_approved.store(true, Ordering::SeqCst);
            app.exit(0);
        }
        WithoutHost::KeepWindowAndTellPage => {
            if let Some(window) = app.get_webview_window("main") {
                if let Err(error) = window.eval(CLOSE_BLOCKED_SCRIPT) {
                    eprintln!("[whispering] could not tell the page a close was blocked: {error}");
                }
            }
        }
    }
}

/// Whether the page is saying "quit" by navigating to the quit address.
fn is_quit_signal(url: &tauri::Url, port: u16) -> bool {
    is_host_url(url, port) && url.path() == QUIT_PATH
}

/// Whether a line the host printed is its approval to close.
fn is_close_approval(line: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(line.trim())
        .ok()
        .and_then(|value| {
            value
                .get("closeApproved")
                .and_then(serde_json::Value::as_bool)
        })
        == Some(true)
}

struct StartedHost {
    port: u16,
    token: String,
}

fn start_host(app: &App) -> Result<StartedHost, String> {
    let token = launch_token()?;
    let mut command = host_command(app)?;
    command
        .env("WHISPERING_HOST_TOKEN", &token)
        .env_remove("WHISPERING_HOST_STANDALONE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    if cfg!(debug_assertions) {
        command.env("WHISPERING_DEBUG", "1");
    } else {
        // A release shell never enables fixture audio or failure injection.
        command
            .env_remove("WHISPERING_DEBUG")
            .env_remove("WHISPERING_DEBUG_FAIL_ROW_WRITES")
            .env_remove("WHISPERING_DEBUG_FAIL_AUDIO_WRITES")
            .env_remove("WHISPERING_DEBUG_BLOCK_COMMITS");
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("start the folder host: {error}"))?;
    let stdin = child.stdin.take();
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("the folder host has no standard output".into());
        }
    };

    // The host prints one JSON line when it is listening. After that the only
    // line that means anything is its approval to close; the rest is drained
    // so the host can never block on a full pipe.
    let handle = app.handle().clone();
    let (sender, receiver) = mpsc::sync_channel::<Result<String, String>>(1);
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        let first = match reader.read_line(&mut line) {
            Ok(0) => Err("the folder host exited before it was ready".to_string()),
            Ok(_) => Ok(line.clone()),
            Err(error) => Err(format!("read the folder host's ready line: {error}")),
        };
        let _ = sender.send(first);
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => {
                    // The host is gone. That approves nothing: the page may
                    // still hold unsaved work.
                    handle
                        .state::<HostState>()
                        .host_gone
                        .store(true, Ordering::SeqCst);
                    break;
                }
                Ok(_) if is_close_approval(&line) => {
                    handle
                        .state::<HostState>()
                        .close_approved
                        .store(true, Ordering::SeqCst);
                    handle.exit(0);
                }
                Ok(_) => {}
            }
        }
    });

    let ready = match receiver.recv_timeout(READY_TIMEOUT) {
        Ok(Ok(line)) => parse_ready(&line),
        Ok(Err(error)) => Err(error),
        Err(_) => Err("the folder host did not become ready within 20 seconds".to_string()),
    };
    let port = match ready {
        Ok(port) => port,
        Err(error) => {
            drop(stdin);
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };

    let state = app.state::<HostState>();
    *state.process.lock().expect("host state lock poisoned") =
        Some(HostProcess { child, stdin });
    Ok(StartedHost { port, token })
}

/// The port from the host's `{"ready":true,"port":N,...}` line.
fn parse_ready(line: &str) -> Result<u16, String> {
    let value: serde_json::Value = serde_json::from_str(line.trim())
        .map_err(|error| format!("the folder host's ready line is not JSON: {error}"))?;
    if value.get("ready").and_then(serde_json::Value::as_bool) != Some(true) {
        return Err("the folder host's first line is not a ready line".into());
    }
    value
        .get("port")
        .and_then(serde_json::Value::as_u64)
        .and_then(|port| u16::try_from(port).ok())
        .filter(|port| *port != 0)
        .ok_or_else(|| "the folder host reported no port".to_string())
}

fn launch_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|error| format!("generate the per-launch credential: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// A debug shell runs the host from source with Bun and serves this app's
/// `build/` directory. `WHISPERING_BUN` names the Bun executable when it is
/// not on `PATH`.
#[cfg(debug_assertions)]
fn host_command(_app: &App) -> Result<Command, String> {
    let app_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(PathBuf::from)
        .ok_or_else(|| "the src-tauri directory has no parent".to_string())?;
    let bun = std::env::var("WHISPERING_BUN").unwrap_or_else(|_| "bun".to_string());
    let mut command = Command::new(bun);
    command
        .current_dir(&app_dir)
        .arg(app_dir.join("native").join("main.ts"))
        .env("WHISPERING_UI_DIST", app_dir.join("build"));
    Ok(command)
}

/// A release shell runs the compiled host bundled beside its own executable
/// and serves the page bundled as a resource.
#[cfg(not(debug_assertions))]
fn host_command(app: &App) -> Result<Command, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("resolve the Whispering executable: {error}"))?;
    let directory = executable
        .parent()
        .ok_or_else(|| "the Whispering executable has no parent directory".to_string())?;
    let filename = if cfg!(windows) {
        "whispering-host.exe"
    } else {
        "whispering-host"
    };
    let ui = app
        .path()
        .resource_dir()
        .map_err(|error| format!("resolve the bundled page: {error}"))?
        .join("ui");
    let mut command = Command::new(directory.join(filename));
    command.env("WHISPERING_UI_DIST", ui);
    Ok(command)
}

fn is_host_url(url: &tauri::Url, port: u16) -> bool {
    url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(port)
        && url.username().is_empty()
        && url.password().is_none()
}

fn open_app_window(app: &App, port: u16, token: &str) -> Result<(), Box<dyn std::error::Error>> {
    let origin = format!("http://127.0.0.1:{port}");
    let url: tauri::Url = format!("{origin}/").parse()?;
    // Only the host's own page receives the token.
    let script = format!(
        "(() => {{ if (window.location.origin !== {origin}) return; \
         Object.defineProperty(window, '__WHISPERING_BRIDGE__', {{ value: Object.freeze({{ token: {token} }}), enumerable: false }}); }})();",
        origin = serde_json::to_string(&origin)?,
        token = serde_json::to_string(token)?,
    );
    let handle = app.handle().clone();
    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("Whispering")
        .inner_size(1180.0, 780.0)
        .min_inner_size(720.0, 480.0)
        .initialization_script(script)
        .on_navigation(move |url| {
            if is_quit_signal(url, port) {
                // Honored only once the host is gone; while it lives, the page
                // answers through it. The address is never loaded either way.
                let state = handle.state::<HostState>();
                if state.host_gone.load(Ordering::SeqCst) {
                    state.close_approved.store(true, Ordering::SeqCst);
                    handle.exit(0);
                }
                return false;
            }
            is_host_url(url, port)
        })
        .build()?;
    app.state::<HostState>()
        .page_opened
        .store(true, Ordering::SeqCst);
    Ok(())
}

/// Shown when the host could not start, so the reason is on screen and not
/// only in a log.
fn open_failure_window(app: &App, error: &str) -> Result<(), Box<dyn std::error::Error>> {
    let script = format!(
        "window.addEventListener('DOMContentLoaded', () => {{ \
         const target = document.getElementById('reason'); \
         if (target) target.textContent = {reason}; }});",
        reason = serde_json::to_string(error)?,
    );
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Whispering")
        .inner_size(720.0, 420.0)
        .initialization_script(script)
        .build()?;
    Ok(())
}

/// Close the host's standard input, which asks it to settle saves and the
/// running commit and exit, then make sure it is gone.
fn stop_host(app: &AppHandle) {
    let state = app.state::<HostState>();
    let Some(mut process) = state
        .process
        .lock()
        .expect("host state lock poisoned")
        .take()
    else {
        return;
    };
    drop(process.stdin.take());
    let deadline = Instant::now() + SHUTDOWN_TIMEOUT;
    loop {
        match process.child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            Ok(None) | Err(_) => break,
        }
    }
    let _ = process.child.kill();
    let _ = process.child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ready_line_yields_its_port() {
        assert_eq!(
            parse_ready("{\"ready\":true,\"port\":49321,\"root\":\"/tmp/x\"}\n"),
            Ok(49321)
        );
    }

    #[test]
    fn anything_else_is_not_ready() {
        assert!(parse_ready("starting").is_err());
        assert!(parse_ready("{\"ready\":false,\"port\":1}").is_err());
        assert!(parse_ready("{\"ready\":true,\"port\":0}").is_err());
        assert!(parse_ready("{\"ready\":true,\"port\":70000}").is_err());
    }

    #[test]
    fn only_an_explicit_approval_line_closes() {
        assert!(is_close_approval("{\"closeApproved\":true}\n"));
        assert!(!is_close_approval("{\"closeApproved\":false}"));
        assert!(!is_close_approval("{\"ready\":true,\"port\":4000}"));
        assert!(!is_close_approval("closeApproved"));
        assert!(!is_close_approval(""));
    }

    #[test]
    fn a_missing_host_exits_only_before_any_page_was_opened() {
        assert_eq!(without_host(false), WithoutHost::Exit);
        assert_eq!(without_host(true), WithoutHost::KeepWindowAndTellPage);
    }

    #[test]
    fn only_the_quit_address_on_the_host_origin_is_a_quit_signal() {
        let quit: tauri::Url = "http://127.0.0.1:4000/__whispering__/quit".parse().unwrap();
        let page: tauri::Url = "http://127.0.0.1:4000/".parse().unwrap();
        let elsewhere: tauri::Url = "https://example.com/__whispering__/quit".parse().unwrap();
        assert!(is_quit_signal(&quit, 4000));
        assert!(!is_quit_signal(&quit, 4001));
        assert!(!is_quit_signal(&page, 4000));
        assert!(!is_quit_signal(&elsewhere, 4000));
    }

    #[test]
    fn the_close_request_is_one_json_line() {
        let value: serde_json::Value = serde_json::from_str(CLOSE_REQUEST).unwrap();
        assert_eq!(value["type"], "close-requested");
        assert!(!CLOSE_REQUEST.contains('\n'));
    }

    #[test]
    fn only_the_host_origin_is_navigable() {
        let allowed: tauri::Url = "http://127.0.0.1:4000/recordings".parse().unwrap();
        let other_port: tauri::Url = "http://127.0.0.1:4001/".parse().unwrap();
        let other_host: tauri::Url = "https://example.com/".parse().unwrap();
        assert!(is_host_url(&allowed, 4000));
        assert!(!is_host_url(&other_port, 4000));
        assert!(!is_host_url(&other_host, 4000));
    }

    #[test]
    fn launch_tokens_are_long_and_distinct() {
        let first = launch_token().unwrap();
        let second = launch_token().unwrap();
        assert_eq!(first.len(), 64);
        assert_ne!(first, second);
    }
}
