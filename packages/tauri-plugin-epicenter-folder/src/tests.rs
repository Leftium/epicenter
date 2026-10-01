//! The plugin through Tauri's real invoke path, on the mock runtime.
//!
//! Each test builds an app with the plugin installed, creates windows, and
//! sends `plugin:epicenter-folder|...` requests exactly as a page's `invoke` would. The
//! folder is a real directory with a real repository.
//!
//! Key behaviors:
//! - The generated TypeScript bindings match the registered commands.
//! - A window attaches only to scopes registered for its label.
//! - A session belongs to the window that attached it; another window that
//!   names it is denied, and a page never supplies a root.
//! - Two windows share one owner: saves, conflicts, events, and history.
//! - Detaching one window leaves the other and the queued commit.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY};
use tauri::utils::acl::ExecutionContext;
use tauri::webview::InvokeRequest;
use tauri::{App, Listener, Manager, WebviewWindow, WebviewWindowBuilder};

use crate::{init, Author, FolderConfig, FolderExt, ScopeConfig, COMMANDS, PROTOCOL};

const BINDINGS: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../folder/src/native/bindings.gen.ts"
);

/// Set `FOLDER_WRITE_BINDINGS=1` to rewrite the committed bindings.
#[test]
fn the_committed_typescript_bindings_match_the_registered_commands() {
    let generated = std::env::temp_dir().join(format!("folder-bindings-{}.ts", std::process::id()));
    crate::specta_builder::<tauri::Wry>()
        .export(specta_typescript::Typescript::default(), &generated)
        .expect("export the bindings");
    let fresh = std::fs::read_to_string(&generated).unwrap();
    // Specta leaves trailing whitespace in multiline unions. Generation and
    // freshness compare the same normalized text, ending in one newline.
    let fresh = fresh
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n");
    let fresh = format!("{}\n", fresh.trim_end());
    let _ = std::fs::remove_file(&generated);
    if std::env::var_os("FOLDER_WRITE_BINDINGS").is_some() {
        std::fs::write(BINDINGS, &fresh).unwrap();
    }
    let committed = std::fs::read_to_string(BINDINGS).unwrap_or_default();
    assert!(
        committed == fresh,
        "packages/folder/src/native/bindings.gen.ts is stale; run `FOLDER_WRITE_BINDINGS=1 cargo test --offline bindings` in packages/tauri-plugin-epicenter-folder"
    );
    for command in COMMANDS {
        assert!(
            fresh.contains(&format!("'plugin:epicenter-folder|{command}'"))
                || fresh.contains(&format!("\"plugin:epicenter-folder|{command}\"")),
            "{command} is listed for permissions but not registered"
        );
    }
}

struct Fixture {
    app: App<MockRuntime>,
    root: PathBuf,
    _directory: TempDirectory,
}

struct TempDirectory(PathBuf);

impl Drop for TempDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn temp(label: &str) -> TempDirectory {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    std::env::set_var("GIT_CONFIG_GLOBAL", "/dev/null");
    std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");
    let path = std::env::temp_dir().join(format!(
        "folder-plugin-{label}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    ));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).unwrap();
    TempDirectory(std::fs::canonicalize(path).unwrap())
}

/// An app whose windows may call every plugin command, with the scope
/// `notes` registered for `windows`.
fn fixture(label: &str, windows: &[&str], commit_on_edit: bool) -> Fixture {
    let directory = temp(label);
    let root = directory.0.join("notes");
    std::fs::create_dir(&root).unwrap();
    let mut context = mock_context(noop_assets());
    for command in COMMANDS {
        context.runtime_authority_mut().__allow_command(
            format!("plugin:epicenter-folder|{command}"),
            ExecutionContext::Local,
        );
    }
    let app = mock_builder()
        .plugin(init())
        .build(context)
        .expect("mock app");
    app.folders()
        .register(ScopeConfig {
            scope: "notes".to_string(),
            folder: FolderConfig {
                commit_on_edit,
                watch_events: false,
                watch_interval: None,
                ..FolderConfig::new(
                    &root,
                    Author {
                        name: "Test Author".to_string(),
                        email: "test@example.com".to_string(),
                    },
                )
            },
            windows: windows.iter().map(|window| window.to_string()).collect(),
        })
        .unwrap();
    Fixture {
        app,
        root,
        _directory: directory,
    }
}

fn window(app: &App<MockRuntime>, label: &str) -> WebviewWindow<MockRuntime> {
    WebviewWindowBuilder::new(app, label, Default::default())
        .build()
        .expect("mock window")
}

/// One request through the IPC handler: the resolved value, or the rejection.
fn invoke(window: &WebviewWindow<MockRuntime>, command: &str, args: Value) -> Result<Value, Value> {
    tauri::test::get_ipc_response(
        window,
        InvokeRequest {
            cmd: format!("plugin:epicenter-folder|{command}"),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: InvokeBody::Json(args),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .map(|body| body.deserialize::<Value>().expect("a JSON response"))
}

fn attach(window: &WebviewWindow<MockRuntime>) -> u64 {
    let attached = invoke(
        window,
        "attach",
        json!({ "scope": "notes", "protocol": PROTOCOL }),
    )
    .expect("attach");
    attached["session"].as_u64().expect("a session resource ID")
}

fn write(path: &str, content: &str, expected: Value) -> Value {
    json!({ "kind": "write", "path": path, "bytes": content.as_bytes(), "expected": expected })
}

fn apply(
    window: &WebviewWindow<MockRuntime>,
    session: u64,
    changes: Value,
) -> Result<Value, Value> {
    invoke(
        window,
        "apply",
        json!({ "session": session, "changes": changes, "lease": null }),
    )
}

fn git(root: &Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn eventually(what: &str, condition: impl Fn() -> bool) {
    for _ in 0..2000 {
        if condition() {
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    panic!("timed out waiting for {what}");
}

#[test]
fn a_window_attaches_reads_publishes_and_commits_through_invoke() {
    let fixture = fixture("round-trip", &["main"], false);
    let main = window(&fixture.app, "main");
    let attached = invoke(
        &main,
        "attach",
        json!({ "scope": "notes", "protocol": PROTOCOL }),
    )
    .unwrap();
    let session = attached["session"].as_u64().unwrap();
    assert_eq!(attached["snapshot"]["branch"], "main");
    assert_eq!(attached["snapshot"]["commitOnEdit"], false);
    assert_eq!(
        attached["snapshot"]["files"],
        json!({ "state": "unknown", "error": null })
    );
    assert_eq!(attached["snapshot"]["closed"], false);

    apply(
        &main,
        session,
        json!([
            write("todos/a.md", "first", json!({ "kind": "absent" })),
            write("todos/a.png", "image", json!({ "kind": "absent" })),
        ]),
    )
    .unwrap();
    let read = invoke(
        &main,
        "read",
        json!({ "session": session, "path": "todos/a.md" }),
    )
    .unwrap();
    assert_eq!(read["bytes"], json!("first".as_bytes()));
    assert_eq!(read["version"]["size"], 5);
    let version = read["version"].clone();
    assert_eq!(
        invoke(
            &main,
            "children",
            json!({ "session": session, "directory": "todos" })
        )
        .unwrap(),
        json!({ "files": ["a.md", "a.png"], "directories": [] })
    );
    assert_eq!(
        invoke(&main, "list", json!({ "session": session })).unwrap(),
        json!({
            "files": [{ "path": "todos/a.md", "size": 5 }, { "path": "todos/a.png", "size": 5 }],
            "directories": ["todos"],
        })
    );
    let many = invoke(
        &main,
        "read_many",
        json!({ "session": session, "paths": ["todos/a.png", "missing.md"] }),
    )
    .unwrap();
    assert_eq!(many[0]["status"], "ok");
    assert_eq!(many[0]["value"]["bytes"], json!("image".as_bytes()));
    assert_eq!(
        many[1],
        json!({ "status": "err", "error": { "name": "NotFound", "path": "missing.md" } })
    );

    // A typed refusal crosses as the rejection, with nothing written.
    let conflict = apply(
        &main,
        session,
        json!([write("todos/a.md", "again", json!({ "kind": "absent" }))]),
    )
    .unwrap_err();
    assert_eq!(conflict["name"], "Refused");
    assert_eq!(conflict["error"]["name"], "Conflict");
    assert_eq!(conflict["error"]["actual"], version);
    let escaped = apply(
        &main,
        session,
        json!([write("../outside.md", "x", json!({ "kind": "any" }))]),
    )
    .unwrap_err();
    assert_eq!(escaped["error"]["name"], "InvalidPath");
    assert!(!fixture.root.parent().unwrap().join("outside.md").exists());

    // A save over the exact version that was read replaces it.
    apply(
        &main,
        session,
        json!([write(
            "todos/a.md",
            "second",
            json!({ "kind": "version", "sha256": version["sha256"], "size": 5 })
        )]),
    )
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("todos/a.md")).unwrap(),
        "second"
    );

    let status = invoke(
        &main,
        "status",
        json!({ "session": session, "lease": null }),
    )
    .unwrap();
    assert_eq!(
        status["changes"],
        json!([{ "path": "todos/a.md", "kind": "add" }, { "path": "todos/a.png", "kind": "add" }])
    );
    let pass = invoke(
        &main,
        "commit",
        json!({ "session": session, "lease": null }),
    )
    .unwrap();
    assert_eq!(pass["outcome"]["status"], "committed");
    assert_eq!(pass["outcome"]["message"], "Update 2 files");
    assert_eq!(pass["outcome"]["changedPaths"], 2);
    assert_eq!(pass["followingPush"], Value::Null);
    assert_eq!(
        git(&fixture.root, &["log", "--format=%s"]),
        "Update 2 files"
    );
    let log = invoke(&main, "log", json!({ "session": session, "depth": 5 })).unwrap();
    assert_eq!(log[0]["oid"], pass["outcome"]["oid"]);
    assert_eq!(log[0]["author"]["name"], "Test Author");
    assert_eq!(
        invoke(
            &main,
            "push",
            json!({ "session": session, "joining": null })
        )
        .unwrap(),
        json!({ "status": "noRemote" })
    );
    assert_eq!(
        invoke(&main, "fetch", json!({ "session": session })).unwrap_err(),
        json!({ "name": "NoRemote" })
    );
    assert_eq!(
        invoke(
            &main,
            "pull_fast_forward",
            json!({ "session": session, "lease": null })
        )
        .unwrap_err(),
        json!({ "name": "Git", "error": { "name": "NoRemote" } })
    );

    // Manual staging through invoke, since this scope does not commit on edit.
    apply(
        &main,
        session,
        json!([write("b.md", "B", json!({ "kind": "absent" }))]),
    )
    .unwrap();
    invoke(
        &main,
        "stage",
        json!({ "session": session, "paths": ["b.md"] }),
    )
    .unwrap();
    assert_eq!(
        invoke(&main, "paths", json!({ "session": session })).unwrap(),
        json!([{ "path": "b.md", "index": "A", "worktree": " " }])
    );
    let diff = invoke(
        &main,
        "diff",
        json!({ "session": session, "staged": true, "paths": [] }),
    )
    .unwrap();
    assert!(diff.as_str().unwrap().contains("+B"));
    let staged = invoke(
        &main,
        "commit_staged",
        json!({ "session": session, "message": "Add b" }),
    )
    .unwrap();
    assert_eq!(staged["parent"], pass["outcome"]["oid"]);
    assert_eq!(
        git(&fixture.root, &["rev-parse", "HEAD"]),
        staged["oid"].as_str().unwrap()
    );

    for response in [&status, &pass, &staged] {
        assert!(response.to_string().len() < 1024, "{response}");
    }
}

#[test]
fn a_window_reaches_only_its_own_scopes_and_its_own_sessions() {
    let fixture = fixture("sessions", &["a", "b"], false);
    let a = window(&fixture.app, "a");
    let b = window(&fixture.app, "b");
    let intruder = window(&fixture.app, "intruder");

    assert_eq!(
        invoke(
            &intruder,
            "attach",
            json!({ "scope": "notes", "protocol": PROTOCOL })
        )
        .unwrap_err(),
        json!({ "name": "WindowNotPermitted", "scope": "notes", "window": "intruder" })
    );
    assert_eq!(
        invoke(
            &a,
            "attach",
            json!({ "scope": "elsewhere", "protocol": PROTOCOL })
        )
        .unwrap_err(),
        json!({ "name": "UnknownScope", "scope": "elsewhere" })
    );
    assert!(
        !fixture.root.join(".git").exists(),
        "a refused attach opens nothing"
    );
    // A page cannot name a root: the command has no such argument to honor.
    let ignored = invoke(
        &a,
        "attach",
        json!({ "scope": "notes", "protocol": PROTOCOL, "root": "/tmp/elsewhere" }),
    )
    .unwrap();
    assert_eq!(
        ignored["root"],
        fixture.root.display().to_string(),
        "attach reports the owner's root"
    );
    assert_eq!(
        invoke(
            &b,
            "attach",
            json!({ "scope": "notes", "protocol": PROTOCOL + 1 })
        )
        .unwrap_err(),
        json!({ "name": "Incompatible", "host": PROTOCOL, "page": PROTOCOL + 1 })
    );
    let a_session = ignored["session"].as_u64().unwrap();
    assert!(
        fixture.root.join(".git/HEAD").is_file(),
        "the registered root was opened"
    );
    apply(
        &a,
        a_session,
        json!([write("a.md", "from a", json!({ "kind": "absent" }))]),
    )
    .unwrap();

    // Another window naming A's session is denied on every kind of call.
    let denied = json!({
        "name": "Denied",
        "reason": "this window has no such folder session; attach first",
    });
    for window in [&b, &intruder] {
        assert_eq!(
            invoke(
                window,
                "read",
                json!({ "session": a_session, "path": "a.md" })
            )
            .unwrap_err(),
            denied
        );
        assert_eq!(
            apply(
                window,
                a_session,
                json!([write("a.md", "stolen", json!({ "kind": "any" }))])
            )
            .unwrap_err(),
            json!({ "name": "Refused", "error": denied })
        );
        assert_eq!(
            invoke(
                window,
                "commit",
                json!({ "session": a_session, "lease": null })
            )
            .unwrap_err(),
            denied
        );
        assert_eq!(
            invoke(
                window,
                "pull_fast_forward",
                json!({ "session": a_session, "lease": null })
            )
            .unwrap_err(),
            json!({ "name": "Git", "error": denied })
        );
        assert_eq!(
            invoke(window, "acquire_lease", json!({ "session": a_session })).unwrap_err(),
            denied
        );
    }
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("a.md")).unwrap(),
        "from a"
    );
}

#[test]
fn two_windows_share_one_owner_and_detaching_one_leaves_the_other() {
    let fixture = fixture("shared", &["a", "b"], true);
    let a = window(&fixture.app, "a");
    let b = window(&fixture.app, "b");
    let heard: Arc<Mutex<Vec<Value>>> = Arc::default();
    let listener = Arc::clone(&heard);
    fixture.app.listen_any(
        "plugin:epicenter-folder:folder-files-changed",
        move |event| {
            listener
                .lock()
                .unwrap()
                .push(serde_json::from_str(event.payload()).unwrap());
        },
    );
    let a_session = attach(&a);
    let b_session = attach(&b);

    apply(
        &a,
        a_session,
        json!([write("a.md", "base", json!({ "kind": "absent" }))]),
    )
    .unwrap();
    let base = invoke(&b, "read", json!({ "session": b_session, "path": "a.md" })).unwrap()
        ["version"]
        .clone();
    let expected = json!({ "kind": "version", "sha256": base["sha256"], "size": base["size"] });

    // Both windows save over the version they both read: exactly one lands.
    let results: Vec<Result<Value, Value>> = std::thread::scope(|scope| {
        let saves = [(&a, a_session, "from a"), (&b, b_session, "from b")].map(
            |(window, session, content)| {
                let expected = expected.clone();
                scope.spawn(move || {
                    apply(window, session, json!([write("a.md", content, expected)]))
                })
            },
        );
        saves.into_iter().map(|save| save.join().unwrap()).collect()
    });
    assert_eq!(
        results.iter().filter(|result| result.is_ok()).count(),
        1,
        "{results:?}"
    );
    let lost = results
        .iter()
        .find_map(|result| result.as_ref().err())
        .unwrap();
    assert_eq!(lost["error"]["name"], "Conflict");

    // Each attached window heard the saves, whichever window made them.
    eventually("both windows to hear both saves", || {
        heard.lock().unwrap().len() >= 4
    });
    assert!(heard
        .lock()
        .unwrap()
        .iter()
        .all(|event| event["scope"] == "notes" && event["paths"] == json!(["a.md"])));

    // Window A saves and goes away at once; the owner still commits it.
    apply(
        &a,
        a_session,
        json!([write(
            "last.md",
            "saved as the page closed",
            json!({ "kind": "absent" })
        )]),
    )
    .unwrap();
    invoke(&a, "detach", json!({ "session": a_session })).unwrap();
    assert_eq!(
        invoke(&a, "read", json!({ "session": a_session, "path": "a.md" })).unwrap_err()["name"],
        "Denied"
    );
    eventually("the detached window's save to be committed", || {
        fixture.root.join(".git/refs/heads/main").exists()
            && git(&fixture.root, &["ls-tree", "-r", "--name-only", "HEAD"]) == "a.md\nlast.md"
    });

    // Window B is untouched: same session, same owner, same history.
    apply(
        &b,
        b_session,
        json!([write("b.md", "after a left", json!({ "kind": "absent" }))]),
    )
    .unwrap();
    eventually("window B's save to be committed", || {
        git(&fixture.root, &["ls-tree", "-r", "--name-only", "HEAD"]) == "a.md\nb.md\nlast.md"
    });
    let status = invoke(&b, "status", json!({ "session": b_session, "lease": null })).unwrap();
    assert_eq!(status["changes"], json!([]));

    // A terminal lease in B holds A's new session out until it is released.
    let a_again = attach(&a);
    let lease = invoke(&b, "acquire_lease", json!({ "session": b_session })).unwrap();
    invoke(
        &b,
        "apply",
        json!({
            "session": b_session,
            "changes": [write("leased.md", "from the terminal", json!({ "kind": "absent" }))],
            "lease": lease,
        }),
    )
    .unwrap();
    // Window A is permitted on this scope and knows the number, but the lease
    // belongs to window B's session: A cannot join B's command with it.
    let not_held = json!({
        "name": "Denied",
        "reason": "this session does not hold that terminal lease",
    });
    assert_eq!(
        invoke(
            &a,
            "apply",
            json!({
                "session": a_again,
                "changes": [write("stolen.md", "joined b's command", json!({ "kind": "absent" }))],
                "lease": lease,
            }),
        )
        .unwrap_err(),
        json!({ "name": "Refused", "error": not_held })
    );
    for command in ["commit", "status"] {
        assert_eq!(
            invoke(&a, command, json!({ "session": a_again, "lease": lease })).unwrap_err(),
            not_held
        );
    }
    assert_eq!(
        invoke(
            &a,
            "mkdir",
            json!({ "session": a_again, "path": "made", "lease": lease })
        )
        .unwrap_err(),
        not_held
    );
    assert!(!fixture.root.join("stolen.md").exists() && !fixture.root.join("made").exists());

    let (done, finished) = std::sync::mpsc::channel();
    std::thread::scope(|scope| {
        scope.spawn(|| {
            let result = apply(
                &a,
                a_again,
                json!([write("waiting.md", "x", json!({ "kind": "absent" }))]),
            );
            done.send(result).unwrap();
        });
        assert!(
            finished.recv_timeout(Duration::from_millis(200)).is_err(),
            "the save waits for the lease"
        );
        invoke(
            &b,
            "release_lease",
            json!({ "session": b_session, "lease": lease }),
        )
        .unwrap();
        finished
            .recv_timeout(Duration::from_secs(20))
            .unwrap()
            .unwrap();
    });

    // Shutdown drains what was admitted and refuses what comes after.
    fixture.app.folders().shutdown();
    assert_eq!(
        apply(
            &b,
            b_session,
            json!([write("late.md", "x", json!({ "kind": "absent" }))])
        )
        .unwrap_err(),
        json!({ "name": "Refused", "error": { "name": "Closed" } })
    );
    assert_eq!(
        invoke(
            &a,
            "attach",
            json!({ "scope": "notes", "protocol": PROTOCOL })
        )
        .unwrap_err(),
        json!({ "name": "ShuttingDown" })
    );
    assert_eq!(
        git(&fixture.root, &["status", "--porcelain"]),
        "",
        "everything admitted was committed"
    );
}

#[test]
fn a_page_reload_ends_that_pages_sessions_and_leases_and_nothing_else() {
    let fixture = fixture("reload", &["a", "b"], true);
    let a = window(&fixture.app, "a");
    let b = window(&fixture.app, "b");
    let a_session = attach(&a);
    let b_session = attach(&b);
    // Another plugin's resource in the same webview must survive the reload.
    struct Unrelated;
    impl tauri::Resource for Unrelated {}
    let unrelated = a.as_ref().resources_table().add(Unrelated);

    // The old page saved, and holds a terminal lease, when it is replaced.
    apply(
        &a,
        a_session,
        json!([write(
            "before.md",
            "saved before the reload",
            json!({ "kind": "absent" })
        )]),
    )
    .unwrap();
    invoke(&a, "acquire_lease", json!({ "session": a_session })).unwrap();
    crate::commands::end_page(a.as_ref());

    // Its session is gone, so its lease no longer holds the folder.
    assert_eq!(
        invoke(
            &a,
            "read",
            json!({ "session": a_session, "path": "before.md" })
        )
        .unwrap_err()["name"],
        "Denied"
    );
    assert!(
        a.as_ref().resources_table().has(unrelated),
        "other resources are untouched"
    );
    apply(
        &b,
        b_session,
        json!([write(
            "b.md",
            "window b never waited",
            json!({ "kind": "absent" })
        )]),
    )
    .unwrap();

    // The new page attaches again and finds what the old one saved.
    let again = attach(&a);
    assert_ne!(again, a_session);
    let read = invoke(&a, "read", json!({ "session": again, "path": "before.md" })).unwrap();
    assert_eq!(read["bytes"], json!("saved before the reload".as_bytes()));
    eventually("the old page's save to be committed", || {
        fixture.root.join(".git/refs/heads/main").exists()
            && git(&fixture.root, &["ls-tree", "-r", "--name-only", "HEAD"]) == "b.md\nbefore.md"
    });
}

type AttachHook = Arc<dyn Fn() + Send + Sync>;

/// Runs inside `attach` for one window label, after the folder was opened
/// and before the session is registered: where a slow open would leave it.
static ATTACH_HOOKS: Mutex<Vec<(String, AttachHook)>> = Mutex::new(Vec::new());

pub(crate) fn attach_opened(label: &str) {
    let hook = ATTACH_HOOKS
        .lock()
        .unwrap()
        .iter()
        .find(|(held, _)| held == label)
        .map(|(_, hook)| Arc::clone(hook));
    if let Some(hook) = hook {
        hook();
    }
}

/// Hold the first attach from `label` after its folder opened. Returns what
/// tells the test the attach is held, and what lets it go.
fn hold_first_attach(label: &str) -> (std::sync::mpsc::Receiver<()>, std::sync::mpsc::Sender<()>) {
    let (reached, at_hook) = std::sync::mpsc::channel::<()>();
    let (release, gate) = std::sync::mpsc::channel::<()>();
    let gate = Mutex::new(gate);
    let once = std::sync::atomic::AtomicBool::new(true);
    ATTACH_HOOKS.lock().unwrap().push((
        label.to_string(),
        Arc::new(move || {
            if once.swap(false, std::sync::atomic::Ordering::SeqCst) {
                reached.send(()).unwrap();
                gate.lock().unwrap().recv().unwrap();
            }
        }),
    ));
    (at_hook, release)
}

#[test]
fn a_destroyed_window_ends_its_sessions_after_the_manager_forgot_its_webview() {
    let fixture = fixture("destroyed", &["a", "b"], true);
    let a = window(&fixture.app, "a");
    let b = window(&fixture.app, "b");
    let a_session = attach(&a);
    let b_session = attach(&b);
    apply(
        &a,
        a_session,
        json!([write(
            "before.md",
            "saved before the window closed",
            json!({ "kind": "absent" })
        )]),
    )
    .unwrap();
    // The window is destroyed while one of its terminal commands holds the folder.
    invoke(&a, "acquire_lease", json!({ "session": a_session })).unwrap();

    // What Tauri does before any plugin hears `Destroyed`: the manager drops
    // the webview. From here the plugin cannot look the webview up by label,
    // which is how the old cleanup found the sessions and why it found none.
    a.as_ref().close().unwrap();
    assert!(
        fixture.app.get_webview_window("a").is_none(),
        "the manager no longer has the webview"
    );
    // The plugin's `Destroyed` handler, in that order.
    crate::window_destroyed(fixture.app.handle(), "a");

    // The session ended: its lease is released, so window B's save does not wait.
    let (done, finished) = std::sync::mpsc::channel();
    std::thread::scope(|scope| {
        scope.spawn(|| {
            done.send(apply(
                &b,
                b_session,
                json!([write(
                    "b.md",
                    "window b carried on",
                    json!({ "kind": "absent" })
                )]),
            ))
            .unwrap();
        });
        finished
            .recv_timeout(Duration::from_secs(10))
            .expect("the destroyed window's lease no longer holds the folder")
            .unwrap();
    });
    // A request that still reaches the old webview finds no live session.
    let ended = invoke(
        &a,
        "read",
        json!({ "session": a_session, "path": "before.md" }),
    )
    .unwrap_err();
    assert_eq!(ended["name"], "Denied");
    assert_eq!(
        apply(
            &a,
            a_session,
            json!([write("late.md", "x", json!({ "kind": "any" }))])
        )
        .unwrap_err()["error"]["name"],
        "Denied"
    );
    assert!(!fixture.root.join("late.md").exists());
    // Window B keeps its session, and the save admitted before the window
    // closed is still committed by the owner.
    let read = invoke(
        &b,
        "read",
        json!({ "session": b_session, "path": "before.md" }),
    )
    .unwrap();
    assert_eq!(
        read["bytes"],
        json!("saved before the window closed".as_bytes())
    );
    eventually("both saves to be committed", || {
        fixture.root.join(".git/refs/heads/main").exists()
            && git(&fixture.root, &["ls-tree", "-r", "--name-only", "HEAD"]) == "b.md\nbefore.md"
    });
    // Destroying it again, or a window that never attached, changes nothing.
    crate::window_destroyed(fixture.app.handle(), "a");
    crate::window_destroyed(fixture.app.handle(), "never-existed");
    assert!(invoke(&b, "list", json!({ "session": b_session })).is_ok());
}

#[test]
fn a_stale_webview_handle_neither_joins_nor_ends_another_webviews_sessions() {
    // Two real webviews, each with the identity the webview-ready hook gave
    // it. The mock manager keeps a destroyed window's entry, so the second
    // cannot be built under the first one's label here; the same-label case
    // is exercised on the identity objects in the test after this one.
    let fixture = fixture("stale-handle", &["old", "successor"], false);
    let old = window(&fixture.app, "old");
    let old_session = attach(&old);
    old.as_ref().close().unwrap();
    crate::window_destroyed(fixture.app.handle(), "old");
    let successor = window(&fixture.app, "successor");
    let session = attach(&successor);
    apply(
        &successor,
        session,
        json!([write(
            "new.md",
            "from the new window",
            json!({ "kind": "absent" })
        )]),
    )
    .unwrap();

    // A request the old page sent before it died is only now delivered. It
    // arrives on the old webview handle, whose own instance has ended.
    assert_eq!(
        invoke(
            &old,
            "attach",
            json!({ "scope": "notes", "protocol": PROTOCOL })
        )
        .unwrap_err(),
        json!({ "name": "Unavailable", "message": "the page that was attaching is gone" })
    );
    assert_eq!(
        invoke(
            &old,
            "read",
            json!({ "session": old_session, "path": "new.md" })
        )
        .unwrap_err()["name"],
        "Denied"
    );
    // A late page-load callback for the old webview ends nothing elsewhere,
    // and neither does a repeated `Destroyed` for its window.
    crate::commands::end_page(old.as_ref());
    crate::window_destroyed(fixture.app.handle(), "old");
    let read = invoke(
        &successor,
        "read",
        json!({ "session": session, "path": "new.md" }),
    )
    .unwrap();
    assert_eq!(read["bytes"], json!("from the new window".as_bytes()));
    let registered = |window: &WebviewWindow<MockRuntime>| {
        window
            .as_ref()
            .resources_table()
            .names()
            .filter(|(_, name)| name == "epicenter-folder-session")
            .count()
    };
    assert_eq!(registered(&successor), 1);
}

#[test]
fn a_window_recreated_under_the_same_label_is_a_separate_instance() {
    use crate::lifecycle::{Lifecycles, Live, SessionState};
    use epicenter_folder_core::registry::Registry;

    // Real sessions on a real folder; the identity objects are the ones the
    // plugin keeps per webview. No webview is involved, because the mock
    // runtime cannot hold two under one label.
    let directory = temp("same-label");
    let root = directory.0.join("notes");
    std::fs::create_dir(&root).unwrap();
    let registry = Registry::new();
    registry
        .register(ScopeConfig {
            scope: "notes".to_string(),
            folder: FolderConfig {
                commit_on_edit: false,
                watch_events: false,
                watch_interval: None,
                ..FolderConfig::new(
                    &root,
                    Author {
                        name: "Test Author".to_string(),
                        email: "test@example.com".to_string(),
                    },
                )
            },
            windows: vec!["late".to_string()],
        })
        .unwrap();
    let session_for = |instance: &Arc<crate::lifecycle::Instance>| {
        let session = registry.attach("notes", "late").unwrap();
        let subscription = session.authorize("late").unwrap().subscribe(|_| {});
        SessionState::new(
            instance,
            Live {
                session,
                leases: Default::default(),
                _subscription: subscription,
            },
        )
    };
    let live = |session: &Arc<SessionState>| session.owner("late").is_ok();

    let lifecycles = Lifecycles::default();
    // The first window labelled `late`, with a session and an attach in flight.
    let old = lifecycles.created("late");
    let old_page = old.page().unwrap();
    let old_session = session_for(&old);
    assert_eq!(old.register(old_page, &old_session, || ()), Some(()));
    let in_flight = session_for(&old);

    // It is destroyed, and a window is created again under the same label.
    lifecycles.window_destroyed("late");
    assert!(!live(&old_session));
    let new = lifecycles.created("late");
    let new_page = new.page().unwrap();
    let new_session = session_for(&new);
    assert_eq!(new.register(new_page, &new_session, || ()), Some(()));

    // The old instance is over for good: the attach that was in flight, and
    // one that only starts now on the old handle, both register nothing.
    assert_eq!(old.page(), None);
    assert_eq!(old.register(old_page, &in_flight, || ()), None);
    assert_eq!(old.register(new_page, &in_flight, || ()), None);
    // A late reload callback for the old instance ends nothing of the new one.
    old.page_started();
    assert!(live(&new_session));
    assert_eq!(
        new.page(),
        Some(new_page),
        "the new instance's page did not move"
    );

    // The new instance's own reload ends its own sessions and fences its own
    // pending attach.
    let pending = session_for(&new);
    new.page_started();
    assert!(!live(&new_session));
    assert_eq!(new.register(new_page, &pending, || ()), None);
    let reloaded = session_for(&new);
    assert_eq!(
        new.register(new.page().unwrap(), &reloaded, || ()),
        Some(())
    );

    // `Destroyed` for the label now ends the new instance, and only then.
    lifecycles.window_destroyed("late");
    assert!(!live(&reloaded));
    assert_eq!(new.page(), None);
    registry.shutdown();
}

#[test]
fn an_attach_that_finishes_after_its_window_was_destroyed_registers_nothing() {
    let fixture = fixture("late-attach", &["late", "b"], false);
    let late = window(&fixture.app, "late");
    let b = window(&fixture.app, "b");
    let b_session = attach(&b);

    // The first attach from `late` is held after the folder opened.
    let (at_hook, release) = hold_first_attach("late");

    std::thread::scope(|scope| {
        let in_flight = scope.spawn(|| {
            invoke(
                &late,
                "attach",
                json!({ "scope": "notes", "protocol": PROTOCOL }),
            )
        });
        at_hook.recv().unwrap();

        // Its window is destroyed, manager first, as in the app's event loop.
        late.as_ref().close().unwrap();
        crate::window_destroyed(fixture.app.handle(), "late");

        // The old attach finishes now. Its webview's instance has ended.
        release.send(()).unwrap();
        let refused = in_flight.join().unwrap().unwrap_err();
        assert_eq!(
            refused,
            json!({ "name": "Unavailable", "message": "the page that was attaching is gone" })
        );
        // It registered nothing in the webview it still held.
        let sessions = late
            .as_ref()
            .resources_table()
            .names()
            .filter(|(_, name)| name == "epicenter-folder-session")
            .count();
        assert_eq!(sessions, 0);
        // The folder it opened stays open for the window that is still there.
        assert!(invoke(&b, "list", json!({ "session": b_session })).is_ok());
    });

    // An attach that only starts now on the old handle is refused as well.
    assert_eq!(
        invoke(
            &late,
            "attach",
            json!({ "scope": "notes", "protocol": PROTOCOL })
        )
        .unwrap_err(),
        json!({ "name": "Unavailable", "message": "the page that was attaching is gone" })
    );
}

#[test]
fn a_reload_fences_an_attach_in_flight_for_the_old_page() {
    let fixture = fixture("reload-attach", &["reloading"], false);
    let page = window(&fixture.app, "reloading");
    let (at_hook, release) = hold_first_attach("reloading");

    std::thread::scope(|scope| {
        let in_flight = scope.spawn(|| {
            invoke(
                &page,
                "attach",
                json!({ "scope": "notes", "protocol": PROTOCOL }),
            )
        });
        at_hook.recv().unwrap();
        // The page-load hook's body, for a reload of the same webview.
        crate::commands::end_page(page.as_ref());
        let new_session = attach(&page);
        release.send(()).unwrap();
        assert_eq!(
            in_flight.join().unwrap().unwrap_err()["name"],
            "Unavailable"
        );
        assert!(invoke(&page, "list", json!({ "session": new_session })).is_ok());
    });
}

/// Runs inside `end_page` for one webview label, after the page advanced and
/// before the old page's table entries are removed.
static PAGE_HOOKS: Mutex<Vec<(String, AttachHook)>> = Mutex::new(Vec::new());

pub(crate) fn page_advanced(label: &str) {
    let hook = PAGE_HOOKS
        .lock()
        .unwrap()
        .iter()
        .find(|(held, _)| held == label)
        .map(|(_, hook)| Arc::clone(hook));
    if let Some(hook) = hook {
        hook();
    }
}

#[test]
fn a_session_the_new_page_attaches_during_reload_cleanup_survives_it() {
    let fixture = fixture("reload-cleanup", &["reloading-cleanup"], false);
    let page = window(&fixture.app, "reloading-cleanup");
    let old_session = attach(&page);

    // The reload has advanced the page and ended the old page's sessions, and
    // has not yet removed their table entries. The new page attaches here.
    let new_session: Arc<Mutex<Option<u64>>> = Arc::default();
    let attached = Arc::clone(&new_session);
    let attaching = page.clone();
    let once = std::sync::atomic::AtomicBool::new(true);
    PAGE_HOOKS.lock().unwrap().push((
        "reloading-cleanup".to_string(),
        Arc::new(move || {
            if once.swap(false, std::sync::atomic::Ordering::SeqCst) {
                *attached.lock().unwrap() = Some(attach(&attaching));
            }
        }),
    ));
    crate::commands::end_page(page.as_ref());

    let new_session = new_session.lock().unwrap().expect("the new page attached");
    assert_ne!(new_session, old_session);
    // The new page's session is live and still in the table.
    apply(
        &page,
        new_session,
        json!([write(
            "new.md",
            "from the new page",
            json!({ "kind": "absent" })
        )]),
    )
    .expect("the cleanup of the old page did not close the new page's session");
    // The old page's session ended and its entry is gone.
    assert_eq!(
        invoke(&page, "list", json!({ "session": old_session })).unwrap_err(),
        json!({
            "name": "Denied",
            "reason": "this window has no such folder session; attach first",
        })
    );
    let registered = page
        .as_ref()
        .resources_table()
        .names()
        .filter(|(_, name)| name == "epicenter-folder-session")
        .count();
    assert_eq!(registered, 1, "only the new page's session remains");
}

/// A line-oriented bridge to the real invoke handler, for the TypeScript
/// adapter's conformance tests in `packages/app/src/files/tauri-native.test.ts`.
///
/// Each stdin line is `{ id, window, cmd, args }`; each reply is one stdout
/// line `FOLDER_BRIDGE { id, ok | err }`. Events a window receives are printed
/// as `FOLDER_BRIDGE { event, window, payload }`. Requests run concurrently,
/// as a page's would. Closing stdin shuts the folders down.
#[test]
#[ignore = "run through packages/app/src/files/tauri-native.test.ts"]
fn invoke_bridge() {
    use std::io::{BufRead, Write};

    fn emit(value: Value) {
        let mut stdout = std::io::stdout().lock();
        writeln!(stdout, "FOLDER_BRIDGE {value}").unwrap();
        stdout.flush().unwrap();
    }

    let root = PathBuf::from(std::env::var("FOLDER_BRIDGE_ROOT").expect("the folder to open"));
    std::env::set_var("GIT_CONFIG_GLOBAL", "/dev/null");
    std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");
    let mut context = mock_context(noop_assets());
    for command in COMMANDS {
        context.runtime_authority_mut().__allow_command(
            format!("plugin:epicenter-folder|{command}"),
            ExecutionContext::Local,
        );
    }
    let app = mock_builder()
        .plugin(init())
        .build(context)
        .expect("mock app");
    app.folders()
        .register(ScopeConfig {
            scope: "notes".to_string(),
            folder: FolderConfig {
                commit_on_edit: std::env::var_os("FOLDER_BRIDGE_MANUAL").is_none(),
                watch_events: false,
                watch_interval: None,
                ..FolderConfig::new(
                    &root,
                    Author {
                        name: "Test Author".to_string(),
                        email: "test@example.com".to_string(),
                    },
                )
            },
            windows: vec!["a".to_string(), "b".to_string()],
        })
        .unwrap();
    let windows: std::collections::BTreeMap<&str, WebviewWindow<MockRuntime>> =
        ["a", "b", "intruder"]
            .into_iter()
            .map(|label| {
                let created = window(&app, label);
                for event in [
                    "plugin:epicenter-folder:folder-snapshot-changed",
                    "plugin:epicenter-folder:folder-files-changed",
                ] {
                    created.listen(event, move |received| {
                        emit(json!({
                            "event": event,
                            "window": label,
                            "payload": serde_json::from_str::<Value>(received.payload()).unwrap(),
                        }));
                    });
                }
                (label, created)
            })
            .collect();
    emit(json!({ "ready": true }));

    std::thread::scope(|scope| {
        for line in std::io::stdin().lock().lines() {
            let request: Value = serde_json::from_str(&line.unwrap()).expect("a JSON request");
            let window = &windows[request["window"].as_str().expect("a window label")];
            scope.spawn(move || {
                let result = tauri::test::get_ipc_response(
                    window,
                    InvokeRequest {
                        cmd: request["cmd"].as_str().expect("a command").to_string(),
                        callback: CallbackFn(0),
                        error: CallbackFn(1),
                        url: "tauri://localhost".parse().unwrap(),
                        body: InvokeBody::Json(request["args"].clone()),
                        headers: Default::default(),
                        invoke_key: INVOKE_KEY.to_string(),
                    },
                );
                emit(match result {
                    Ok(body) => {
                        json!({ "id": request["id"], "ok": body.deserialize::<Value>().unwrap() })
                    }
                    Err(error) => json!({ "id": request["id"], "err": error }),
                });
            });
        }
    });
    app.folders().shutdown();
    emit(json!({ "finished": true }));
}

#[test]
fn a_window_without_the_permission_cannot_call_the_plugin() {
    let directory = temp("acl");
    let app = mock_builder()
        .plugin(init())
        .build(mock_context(noop_assets()))
        .unwrap();
    let main = window(&app, "main");
    let refused = invoke(
        &main,
        "attach",
        json!({ "scope": "notes", "protocol": PROTOCOL }),
    )
    .unwrap_err();
    assert!(
        refused
            .as_str()
            .is_some_and(|message| message.contains("not allowed")),
        "{refused}"
    );
    drop(directory);
}
