//! Explicit, isolated acceptance executable. Uses the production Bun launch,
//! native admitted-window creation, departure round, relaunch, and shutdown
//! paths; never reads a real account.
use super::*;
use std::sync::atomic::AtomicUsize;
use tauri::Emitter;

const APP_ID: &str = "so.epicenter.runtimeevidence";
/// No Bun generation ever has this number, so the probe rounds' replies are
/// refused by `send_native_frame` instead of reaching the live sidecar. The
/// probe drives the native round directly; Bun's own preparation is covered
/// by the controlled port and authority tests, not here.
const PROBE_SIDECAR: u64 = u64::MAX;
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

struct Evidence {
    root: PathBuf,
    /// `cycles` for the restart chain, `terminate-now` for the run that asks
    /// AppKit to terminate with no participant window open.
    run: &'static str,
    cycle: usize,
    document: AtomicUsize,
    restarting: AtomicBool,
    /// What the participant probe pages reported, with Tauri's label for the
    /// window each report came from.
    probe: Mutex<Vec<serde_json::Value>>,
    /// How each probe page answers a round: `answer`, `ask`, or `silent`.
    modes: Mutex<std::collections::HashMap<String, &'static str>>,
    /// `PageLoadEvent::Started` deliveries per window label.
    started: Mutex<std::collections::HashMap<String, u64>>,
}

fn record(app: &DesktopAppHandle, mut value: serde_json::Value) {
    let evidence = app.state::<Evidence>();
    if let Some(object) = value.as_object_mut() {
        object.insert("run".into(), evidence.run.into());
    }
    let root = &evidence.root;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("events.jsonl"))
        .unwrap();
    file.write_all(format!("{value}\n").as_bytes()).unwrap();
    file.sync_all().unwrap();
    if value["event"] != "page-load" {
        eprintln!("RUNTIME_EVIDENCE {value}");
    }
}

#[tauri::command]
fn evidence_boot(app: DesktopAppHandle) -> serde_json::Value {
    let state = app.state::<Evidence>();
    let document = state.document.fetch_add(1, Ordering::SeqCst);
    record(
        &app,
        serde_json::json!({"event":"document", "cycle":state.cycle,"document":document}),
    );
    serde_json::json!({"cycle":state.cycle,"document":document})
}

/// A participant probe page reports what it saw. The label is the window
/// Tauri delivered the call from.
#[tauri::command]
fn evidence_probe(window: WebviewWindow, report: serde_json::Value) {
    let app = window.app_handle().clone();
    let entry = serde_json::json!({"label": window.label(), "report": report});
    record(&app, serde_json::json!({"event":"probe", "entry": entry.clone()}));
    app.state::<Evidence>().probe.lock().unwrap().push(entry);
}

/// How this probe page should answer the round it is reading.
#[tauri::command]
fn evidence_probe_mode(window: WebviewWindow) -> &'static str {
    window
        .app_handle()
        .state::<Evidence>()
        .modes
        .lock()
        .unwrap()
        .get(window.label())
        .copied()
        .unwrap_or("answer")
}

#[tauri::command]
fn evidence_result(app: DesktopAppHandle, error: Option<String>) {
    if let Some(error) = error {
        record(&app, serde_json::json!({"event":"failure","error":error}));
        app.exit(1);
        return;
    }
    thread::spawn(move || {
        let evidence = app.state::<Evidence>();
        let cycle = evidence.cycle;
        if evidence.document.load(Ordering::SeqCst) == 1 && cycle < 20 {
            let window = app.get_webview_window(&app_window_label(APP_ID)).unwrap();
            let (send, receive) = mpsc::channel();
            window.on_window_event(move |event| {
                if matches!(event, WindowEvent::Destroyed) {
                    let _ = send.send(());
                }
            });
            window.destroy().unwrap();
            receive.recv_timeout(Duration::from_secs(10)).unwrap();
            let state = app.state::<HostState>();
            let token = state.active_token.lock().unwrap().clone().unwrap();
            launch_on_main_thread(
                &app,
                Application::Admitted(APP_ID.into()),
                state.port().unwrap(),
                &token,
                true,
            )
            .unwrap();
            return;
        }
        record(
            &app,
            serde_json::json!({"event":"committed-survived","cycle":cycle}),
        );
        if cycle == 20 {
            record(
                &app,
                serde_json::json!({"event":"passed","restarts":20,"immediateReopens":20}),
            );
            #[cfg(target_os = "macos")]
            if let Err(error) = probe_terminate(&app) {
                record(&app, serde_json::json!({"event":"failure","error":format!("{error:#}")}));
                app.exit(1);
            }
            #[cfg(not(target_os = "macos"))]
            app.exit(0);
            return;
        }
        fs::write(evidence.root.join("cycle"), (cycle + 1).to_string()).unwrap();
        // The production relaunch: a grant held by this Bun generation, then
        // its `relaunch` frame, which calls `request_restart`. Bun's own
        // preparation is not involved, so its reply is not sent.
        evidence.restarting.store(true, Ordering::SeqCst);
        let request_id = format!("evidence-relaunch-{cycle}");
        departure::grant_without_reply(&app, 1, request_id.clone());
        handle_native_frame(&app, 1, BunToRustNativeFrame::Relaunch { request_id }).unwrap();
    });
}

/// Run `operation` on the main thread and wait for its result.
fn on_main<T: Send + 'static>(
    app: &DesktopAppHandle,
    operation: impl FnOnce(&DesktopAppHandle) -> T + Send + 'static,
) -> Result<T> {
    let (sender, receiver) = mpsc::sync_channel(1);
    let target = app.clone();
    app.run_on_main_thread(move || {
        let _ = sender.send(operation(&target));
    })?;
    receiver
        .recv_timeout(PROBE_TIMEOUT)
        .context("the main thread did not answer the probe")
}

fn wait_until(app: &DesktopAppHandle, what: &str, mut check: impl FnMut() -> bool) -> Result<()> {
    let deadline = Instant::now() + PROBE_TIMEOUT;
    while !check() {
        if let Some(failure) = probe_reports(app)
            .into_iter()
            .find(|entry| entry["report"]["kind"] == "failure")
        {
            bail!("a departure probe page failed: {failure}");
        }
        if Instant::now() > deadline {
            bail!("departure probe timed out waiting for {what}");
        }
        thread::sleep(Duration::from_millis(25));
    }
    Ok(())
}

fn probe_reports(app: &DesktopAppHandle) -> Vec<serde_json::Value> {
    app.state::<Evidence>().probe.lock().unwrap().clone()
}

fn has_report(
    app: &DesktopAppHandle,
    label: &str,
    matches: impl Fn(&serde_json::Value) -> bool,
) -> bool {
    probe_reports(app)
        .iter()
        .any(|entry| entry["label"] == label && matches(&entry["report"]))
}

fn visibility(app: &DesktopAppHandle) -> Result<Vec<(String, bool)>> {
    on_main(app, |app| {
        departure::Participant::ALL
            .into_iter()
            .map(|participant| {
                let visible = app
                    .get_webview_window(participant.label())
                    .and_then(|window| window.is_visible().ok())
                    .unwrap_or(false);
                (participant.label().to_string(), visible)
            })
            .collect()
    })
}

fn set_hidden(app: &DesktopAppHandle, participant: departure::Participant) -> Result<()> {
    on_main(app, move |app| {
        if let Some(window) = app.get_webview_window(participant.label()) {
            let _ = window.hide();
        }
    })
}

fn expect_visibility(app: &DesktopAppHandle, what: &str, expected: [(&str, bool); 2]) -> Result<()> {
    let expected: Vec<(String, bool)> = expected
        .into_iter()
        .map(|(label, visible)| (label.to_string(), visible))
        .collect();
    wait_until(app, what, || {
        visibility(app).is_ok_and(|windows| windows == expected)
    })
}

/// Choose an item of the Window menu, as AppKit would deliver it.
#[cfg(target_os = "macos")]
fn choose_window_menu_item(app: &DesktopAppHandle, participant: departure::Participant) {
    handle_menu_event(app, &departure::window_menu_id(participant));
}

fn probe_status(app: &DesktopAppHandle, participant: departure::Participant) -> departure::StatusWire {
    departure::status_of(app, participant)
}

/// Capture- and Todos-labelled windows at the evidence page, built and adopted
/// as the host builds its own participant windows.
fn open_probe_windows(app: &DesktopAppHandle, port: u16, token: &str) -> Result<()> {
    let token = token.to_string();
    on_main(app, move |app| -> Result<()> {
        let origin = origin(port);
        for participant in departure::Participant::ALL {
            let url: tauri::Url = format!("{origin}/apps/{APP_ID}/").parse()?;
            let builder = WebviewWindowBuilder::new(app, participant.label(), WebviewUrl::External(url));
            let window = isolate_webview(builder)
                .title(format!("Departure probe: {}", participant.title()))
                .initialization_script(initialization_script(&origin, &token)?)
                .on_navigation(move |url| is_allowed_navigation(url, port))
                .build()?;
            departure::adopt_window(&window);
            release_host_resources_on_destroy(&window);
        }
        Ok(())
    })?
}

fn set_modes(app: &DesktopAppHandle, capture: &'static str, todos: &'static str) {
    let evidence = app.state::<Evidence>();
    let mut modes = evidence.modes.lock().unwrap();
    modes.insert("capture".into(), capture);
    modes.insert("todos".into(), todos);
}

/// The last process leaves the way every AppKit quit does, through
/// `[NSApp terminate:]`, delivered from the main run loop as AppKit delivers
/// its own:
///
/// 1. with both probe windows open, the guard refuses termination and the
///    exit request starts a quit round, which both pages read;
/// 2. Capture keeps working, and its same page, with its draft, reads idle;
/// 3. the delegate is the same object, still Tao's, still answering;
/// 4. a second `terminate:` is agreed by both pages, and the process leaves
///    through one Exit, which the shutdown record checks.
#[cfg(target_os = "macos")]
fn probe_terminate(app: &DesktopAppHandle) -> Result<()> {
    use super::departure::Participant::Capture;

    let state = app.state::<HostState>();
    let token = state.active_token().context("the evidence host is active")?;
    open_probe_windows(app, state.port()?, &token)?;
    for label in ["capture", "todos"] {
        wait_until(app, &format!("{label} to read its status"), || {
            has_report(app, label, |report| report["source"] == "activation")
        })?;
    }
    let draft = probe_reports(app)
        .into_iter()
        .find(|entry| entry["label"] == "capture" && entry["report"]["source"] == "activation")
        .map(|entry| entry["report"]["draft"].clone())
        .context("Capture reported its draft")?;
    let generation = probe_status(app, Capture).generation;
    let before = on_main(app, |_| departure::inspect_terminate_guard())?;

    set_modes(app, "cancel", "answer");
    on_main(app, |_| departure::schedule_terminate_for_evidence())?;
    record(app, serde_json::json!({"event":"terminate-scheduled","cycle":20}));
    wait_until(app, "the refused terminate to start a quit round", || {
        has_report(app, "capture", |report| {
            report["status"]["phase"] == "collecting" && report["status"]["intent"] == "quit"
        })
    })?;
    wait_until(app, "Capture to keep working", || {
        has_report(app, "capture", |report| report["kind"] == "kept")
    })?;
    wait_until(app, "Capture's own page to read idle with its draft", || {
        has_report(app, "capture", |report| {
            report["kind"] == "status"
                && report["source"] == "nudge"
                && report["status"]["phase"] == "idle"
                && report["draft"] == draft
        })
    })?;
    if probe_status(app, Capture).generation != generation {
        bail!("Capture's page was replaced while it kept working");
    }
    let after = on_main(app, |_| departure::inspect_terminate_guard())?;
    if after["delegate"] != before["delegate"] || after["taoClass"] != true || after["responds"] != true {
        bail!("the delegate changed under the guard: before {before}, after {after}");
    }
    let replies = departure::terminate_replies_for_evidence();
    if replies != ["cancel-and-quit"] {
        bail!("the guard answered {replies:?} to one terminate: with participant windows open");
    }
    record(
        app,
        serde_json::json!({"event":"terminate-cancelled","cycle":20,"draftKept":true,"replies":replies,"before":before,"after":after}),
    );

    set_modes(app, "answer", "answer");
    on_main(app, |_| departure::schedule_terminate_for_evidence())?;
    record(app, serde_json::json!({"event":"terminate-scheduled","cycle":20}));
    Ok(())
}

/// The round the probe just started, once the main thread has begun it.
fn collecting_round(app: &DesktopAppHandle) -> Result<u64> {
    wait_until(app, "the probe round to begin", || {
        probe_status(app, departure::Participant::Capture).phase == "collecting"
    })?;
    probe_status(app, departure::Participant::Capture)
        .round
        .context("a collecting round has a number")
}

/// Open Capture- and Todos-labelled windows at the evidence page, then drive
/// real departure rounds through them:
///
/// 1. each page's first read, after its listeners registered, carries the
///    generation that every `Started` delivery before it assigned;
/// 2. a nudge emitted to one label reaches that window's scoped listener only;
/// 3. AppKit leaves both windows out of its Window-menu list;
/// 4. with Todos closed, a restart grant hides both windows, each confirmed by
///    `is_visible`, and refuses the Window-menu items; aborting the grant shows
///    Capture and leaves Todos hidden, as the person left it;
/// 5. with Capture silent and Todos deciding, the native dialog's discard
///    hides Capture and records it, the Window-menu item cannot show it but
///    does show Todos, and Bun's withdrawal restores both as they were.
fn probe_departure(app: &DesktopAppHandle, port: u16, token: &str) -> Result<serde_json::Value> {
    use super::departure::Participant::{Capture, Todos};

    open_probe_windows(app, port, token)?;

    let mut generations = serde_json::Map::new();
    for participant in departure::Participant::ALL {
        let label = participant.label();
        wait_until(app, &format!("{label} to read its status"), || {
            has_report(app, label, |report| report["kind"] == "status")
        })?;
        let first = probe_reports(app)
            .into_iter()
            .find(|entry| entry["label"] == label && entry["report"]["kind"] == "status")
            .unwrap();
        let status = &first["report"]["status"];
        let started = app
            .state::<Evidence>()
            .started
            .lock()
            .unwrap()
            .get(label)
            .copied()
            .unwrap_or(0);
        if first["report"]["source"] != "activation"
            || status["phase"] != "idle"
            || started < 1
            || status["generation"].as_u64() != Some(started)
            || status["generation"].as_u64() != Some(probe_status(app, participant).generation)
        {
            bail!("{label}'s first read did not carry its page-load generation ({started} Started): {first}");
        }
        generations.insert(
            label.into(),
            serde_json::json!({"read": status["generation"], "started": started}),
        );
    }

    app.emit_to(Capture.label(), departure::CHANGED_EVENT, ())?;
    wait_until(app, "the targeted nudge", || {
        has_report(app, "capture", |report| {
            report["kind"] == "nudge" && report["scope"] == "window"
        })
    })?;
    // Give a mistargeted delivery the same time to arrive before ruling it out.
    thread::sleep(Duration::from_millis(500));
    if has_report(app, "todos", |report| {
        report["kind"] == "nudge" && report["scope"] == "window"
    }) {
        bail!("a nudge emitted to capture reached todos' window-scoped listener");
    }
    // Recorded, not required: whether a global `listen` hears another label's
    // nudge. Pages use the window-scoped listener and read status anyway.
    let global_reached_todos = has_report(app, "todos", |report| {
        report["kind"] == "nudge" && report["scope"] == "global"
    });

    #[cfg(target_os = "macos")]
    {
        let excluded = on_main(app, |app| {
            departure::Participant::ALL.map(|participant| {
                app.get_webview_window(participant.label())
                    .and_then(|window| departure::is_excluded_from_windows_menu(&window))
            })
        })?;
        if excluded != [Some(true), Some(true)] {
            bail!("AppKit still lists a participant window in the Window menu: {excluded:?}");
        }
    }

    // Grant, then abort, with Todos closed by the person beforehand.
    set_hidden(app, Todos)?;
    expect_visibility(app, "Todos to start hidden", [("capture", true), ("todos", false)])?;
    departure::prepare_restart(app, PROBE_SIDECAR, "probe-grant".into());
    wait_until(app, "the probe round to be granted", || {
        probe_status(app, Capture).phase == "granted"
    })?;
    expect_visibility(app, "the grant to hide both windows", [("capture", false), ("todos", false)])?;
    for participant in departure::Participant::ALL {
        if departure::admits(app, participant.label()) {
            bail!("{} may be revealed while granted", participant.label());
        }
        #[cfg(target_os = "macos")]
        choose_window_menu_item(app, participant);
        let label = participant.label();
        wait_until(app, &format!("{label} to read granted"), || {
            has_report(app, label, |report| report["status"]["phase"] == "granted")
        })?;
    }
    thread::sleep(Duration::from_millis(300));
    expect_visibility(app, "the Window menu to be refused while granted", [("capture", false), ("todos", false)])?;
    departure::relaunch_abort(app, PROBE_SIDECAR, "probe-grant".into());
    expect_visibility(app, "the abort to restore each window as it was", [("capture", true), ("todos", false)])?;
    for participant in departure::Participant::ALL {
        if probe_status(app, participant).phase != "idle" || !departure::admits(app, participant.label()) {
            bail!("{} did not resume after the abort", participant.label());
        }
    }

    // Discard a silent Capture while Todos is still deciding, then withdraw.
    {
        let evidence = app.state::<Evidence>();
        let mut modes = evidence.modes.lock().unwrap();
        modes.insert("capture".into(), "silent");
        modes.insert("todos".into(), "ask");
    }
    departure::prepare_restart(app, PROBE_SIDECAR, "probe-discard".into());
    let round = collecting_round(app)?;
    wait_until(app, "Capture to stay silent and Todos to ask", || {
        has_report(app, "capture", |report| report["kind"] == "silent" && report["round"] == round)
            && has_report(app, "todos", |report| report["kind"] == "asked" && report["round"] == round)
    })?;
    expect_visibility(app, "deciding Todos to be shown although it was closed", [("capture", true), ("todos", true)])?;
    let generation = probe_status(app, Capture).generation;
    departure::answer_dialog_for_evidence(app, round, vec![(Capture, generation)], true);
    wait_until(app, "Capture to be discarded", || {
        probe_status(app, Capture).vote == Some("discarded")
    })?;
    expect_visibility(app, "the discard to hide Capture", [("capture", false), ("todos", true)])?;
    wait_until(app, "Capture's page to read its discard", || {
        has_report(app, "capture", |report| report["status"]["vote"] == "discarded")
    })?;
    if departure::admits(app, "capture") || !departure::admits(app, "todos") {
        bail!("only the discarded page may be refused while collecting");
    }
    #[cfg(target_os = "macos")]
    {
        choose_window_menu_item(app, Capture);
        set_hidden(app, Todos)?;
        choose_window_menu_item(app, Todos);
        expect_visibility(app, "the Window menu to show Todos but not Capture", [("capture", false), ("todos", true)])?;
    }
    departure::prepare_cancel(app, PROBE_SIDECAR, "probe-discard".into());
    expect_visibility(app, "the withdrawal to restore each window as it was", [("capture", true), ("todos", false)])?;
    if probe_status(app, Capture).phase != "idle" || !departure::admits(app, "capture") {
        bail!("Capture did not resume after the withdrawal");
    }

    on_main(app, |app| {
        for participant in departure::Participant::ALL {
            if let Some(window) = app.get_webview_window(participant.label()) {
                let _ = window.destroy();
            }
        }
    })?;
    wait_until(app, "the probe windows to close", || {
        departure::Participant::ALL
            .into_iter()
            .all(|participant| app.get_webview_window(participant.label()).is_none())
    })?;
    Ok(serde_json::json!({
        "event": "departure-probe",
        "passed": true,
        "generations": generations,
        "globalNudgeReachedTodos": global_reached_todos,
        "windowMenuExcluded": cfg!(target_os = "macos"),
        "hiddenRestoredAfterAbort": true,
        "discardHiddenAndRestored": true,
    }))
}

pub fn run() {
    let root = PathBuf::from(
        std::env::var_os("EPICENTER_RUNTIME_EVIDENCE_ROOT").expect("isolated evidence root"),
    );
    assert!(root.is_absolute());
    if std::env::var_os("EPICENTER_RUNTIME_EVIDENCE_CLEANUP").is_some() {
        #[cfg(target_os = "macos")]
        {
            let bytes: [u8; 16] = fs::read(root.join("website-store"))
                .unwrap()
                .try_into()
                .unwrap();
            tauri::Builder::default()
                .setup(move |app| {
                    WebviewWindowBuilder::new(
                        app,
                        "cleanup",
                        WebviewUrl::External("about:blank".parse().unwrap()),
                    )
                    .visible(false)
                    .build()?;
                    let app = app.handle().clone();
                    tauri::async_runtime::spawn(async move {
                        let result = app.remove_data_store(bytes).await;
                        if let Err(error) = &result {
                            eprintln!("Failed to remove isolated WebKit profile: {error}");
                        }
                        app.exit(if result.is_ok() { 0 } else { 1 });
                    });
                    Ok(())
                })
                .build(tauri::test::mock_context(tauri::test::noop_assets()))
                .unwrap()
                .run(|_, _| {});
        }
        return;
    }
    let cycle: usize = fs::read_to_string(root.join("cycle"))
        .unwrap_or_else(|_| "0".into())
        .parse()
        .unwrap();
    let identifier = fs::read_to_string(root.join("identifier")).unwrap();
    assert!(identifier.starts_with("so.epicenter.evidence."));
    let port: u16 = fs::read_to_string(root.join("port"))
        .unwrap()
        .parse()
        .unwrap();
    let terminate_now = std::env::var_os("EPICENTER_RUNTIME_EVIDENCE_TERMINATE_NOW").is_some();
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().identifier = identifier;
    for command in [
        "evidence_boot",
        "evidence_result",
        "evidence_probe",
        "evidence_probe_mode",
        "departure_status",
        "departure_answer",
        "plugin:event|listen",
        "plugin:event|unlisten",
    ] {
        context.runtime_authority_mut().__allow_command(
            command.into(),
            tauri::utils::acl::ExecutionContext::Remote {
                url: format!("http://127.0.0.1:{port}/*").parse().unwrap(),
            },
        );
    }
    let app = tauri::Builder::default()
        .on_page_load(|webview, payload| {
            record(webview.app_handle(), serde_json::json!({"event":"page-load","label":webview.label(),"url":payload.url().to_string(),"phase":format!("{:?}",payload.event())}));
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                *webview
                    .app_handle()
                    .state::<Evidence>()
                    .started
                    .lock()
                    .unwrap()
                    .entry(webview.label().to_string())
                    .or_insert(0) += 1;
                page_started(webview.app_handle(), webview.label());
            }
        })
        .plugin(tauri_plugin_epicenter_folder::init())
        .manage(HostState::new(Ok(port)))
        .manage(departure::Departure::default())
        .manage(Mutex::new(Recorder::new()))
        .manage(Evidence {
            root: root.clone(),
            run: if terminate_now { "terminate-now" } else { "cycles" },
            cycle,
            document: AtomicUsize::new(0),
            restarting: AtomicBool::new(false),
            probe: Mutex::new(Vec::new()),
            modes: Mutex::new(Default::default()),
            started: Mutex::new(Default::default()),
        })
        .manage(app_data::DesktopPaths { data_dir: root.join("data"), folder_dir: root.join("folder") })
        .invoke_handler(tauri::generate_handler![
            evidence_boot,
            evidence_result,
            evidence_probe,
            evidence_probe_mode,
            departure::departure_status,
            departure::departure_answer
        ])
        .setup(move |app| {
            departure::bind_main_thread(app.handle());
            // The production guard, installed the same way, then inspected:
            // the selector was absent and is now answered by the same Tao
            // delegate object, and a second installation is refused.
            #[cfg(target_os = "macos")]
            {
                let before = departure::inspect_terminate_guard();
                departure::install_terminate_guard(app.handle()).map_err(anyhow::Error::msg)?;
                let after = departure::inspect_terminate_guard();
                let second = departure::install_terminate_guard(app.handle()).err();
                if before["taoClass"] != true
                    || before["hasMethod"] != false
                    || after["hasMethod"] != true
                    || after["responds"] != true
                    || after["delegate"] != before["delegate"]
                    || second.is_none()
                {
                    return Err(anyhow!(
                        "the quit guard did not install as expected: before {before}, after {after}, second {second:?}"
                    )
                    .into());
                }
                record(
                    app.handle(),
                    serde_json::json!({"event":"terminate-guard","cycle":cycle,"before":before,"after":after,"secondInstall":second}),
                );
            }
            // Registered, never attached: Exit must still fence the registry.
            app.folders()
                .register(ScopeConfig {
                    scope: "so.epicenter.runtimeevidence.folder".into(),
                    folder: FolderConfig::new(
                        root.join("folder").join("evidence"),
                        FolderAuthor { name: "Evidence".into(), email: "evidence@localhost".into() },
                    ),
                    windows: vec!["capture".into()],
                })
                .map_err(anyhow::Error::msg)?;
            WebviewWindowBuilder::new(app, "evidence-anchor", WebviewUrl::External("about:blank".parse().unwrap())).visible(false).build()?;
            let app = app.handle().clone();
            record(&app, serde_json::json!({"event":"host","cycle":cycle,"pid":std::process::id()}));
            thread::spawn(move || {
                let result = (|| -> Result<()> {
                    let LaunchedHost { child, mut stdin, stdout, token } = launch_host(&app, port)?;
                    let pid = child.id();
                    let (sender, receiver) = mpsc::sync_channel::<String>(64);
                    let writer = thread::spawn(move || { for line in receiver { if writeln!(stdin,"{line}").and_then(|_| stdin.flush()).is_err() { break; } } });
                    let sqlite = sqlite::Worker::new(app.state::<app_data::DesktopPaths>().data_dir.clone(), 1, sender.clone(), Arc::new(AtomicBool::new(false)));
                    let state = app.state::<HostState>();
                    *state.process.lock().unwrap() = Some(ManagedChild { generation:1, child, stdin:Some(sender), sqlite, writer:Some(writer) });
                    state.activate(&token);
                    for frame in [
                        BunToRustNativeFrame::StoreAuth { request_id: "stale".into(), serialized: None },
                        BunToRustNativeFrame::PrepareRelaunch { request_id: "stale".into() },
                        BunToRustNativeFrame::Relaunch { request_id: "stale".into() },
                    ] {
                        assert!(handle_native_frame(&app, 0, frame).unwrap_err().to_string().contains("retired Bun generation"));
                    }
                    record(&app, serde_json::json!({"event":"retired-frames-fenced","cycle":cycle}));
                    record(&app, serde_json::json!({"event":"sidecar","cycle":cycle,"pid":pid}));
                    monitor_host(app.clone(),1,stdout);
                    // No participant window is open: AppKit terminates as it
                    // always has, through Exit and without ExitRequested.
                    #[cfg(target_os = "macos")]
                    if terminate_now {
                        on_main(&app, |_| departure::schedule_terminate_for_evidence())?;
                        record(&app, serde_json::json!({"event":"terminate-now-requested","cycle":cycle}));
                        // Termination happens on the main thread's next turn,
                        // and takes this thread with the process.
                        thread::sleep(Duration::from_secs(15));
                        bail!(
                            "AppKit did not terminate with no participant window open; the guard answered {:?}",
                            departure::terminate_replies_for_evidence()
                        );
                    }
                    if cycle == 0 {
                        let probe = probe_departure(&app, port, &token)?;
                        record(&app, probe);
                    }
                    launch_on_main_thread(&app, Application::Admitted(APP_ID.into()), port, &token, true)?;
                    Ok(())
                })();
                if let Err(error) = result { record(&app, serde_json::json!({"event":"failure","error":format!("{error:#}")}));app.exit(1); }
            });
            Ok(())
        }).build(context).unwrap();
    let handle = app.handle().clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(30));
        record(
            &handle,
            serde_json::json!({"event":"failure","error":"native evidence timed out"}),
        );
        handle.exit(2);
    });
    app.run(|app,event| {
        // The production filter: every exit request but a granted restart
        // asks the departure round.
        if let RunEvent::ExitRequested { api, code, .. } = &event {
            let prevented = prevents_exit(app, *code);
            if prevented {
                api.prevent_exit();
            }
            record(app, serde_json::json!({
                "event":"exit-requested",
                "code":code,
                "prevented":prevented,
                "cycle":app.state::<Evidence>().cycle,
            }));
        }
        if matches!(event,RunEvent::Exit) {
            // Plugins hear Exit before this callback (`on_event_loop_event`),
            // so a fenced registry here means the Folder plugin's shutdown
            // ran on this exit path, the restart path included.
            let folder_fenced = app
                .folders()
                .register(ScopeConfig {
                    scope: "so.epicenter.runtimeevidence.after-exit".into(),
                    folder: FolderConfig::new(
                        app.state::<Evidence>().root.join("folder").join("after-exit"),
                        FolderAuthor { name: "Evidence".into(), email: "evidence@localhost".into() },
                    ),
                    windows: Vec::new(),
                })
                .is_err();
            let pid = app.state::<HostState>().process.lock().unwrap().as_ref().map(|process|process.child.id());
            shutdown_host(app);
            for frame in [
                BunToRustNativeFrame::StoreAuth { request_id: "stopped".into(), serialized: None },
                BunToRustNativeFrame::Relaunch { request_id: "stopped".into() },
            ] {
                assert!(handle_native_frame(app, 1, frame).unwrap_err().to_string().contains("shutdown began"));
            }
            if let Some(pid) = pid { assert_eq!(unsafe { libc::kill(pid as i32,0) },-1); }
            let evidence = app.state::<Evidence>();
            #[cfg(target_os = "macos")]
            let terminate_replies = departure::terminate_replies_for_evidence();
            #[cfg(not(target_os = "macos"))]
            let terminate_replies: Vec<&str> = Vec::new();
            record(app,serde_json::json!({
                "event":"shutdown",
                "sidecarDead":true,
                "folderFenced":folder_fenced,
                "restartRequested":evidence.restarting.load(Ordering::SeqCst),
                "terminateReplies":terminate_replies,
                "cycle":evidence.cycle,
            }));
        }
    });
}

pub(super) fn isolate_webview<'a>(
    builder: WebviewWindowBuilder<'a, Wry, DesktopAppHandle>,
) -> WebviewWindowBuilder<'a, Wry, DesktopAppHandle> {
    let root = PathBuf::from(std::env::var_os("EPICENTER_RUNTIME_EVIDENCE_ROOT").unwrap());
    #[cfg(target_os = "macos")]
    {
        let bytes: [u8; 16] = fs::read(root.join("website-store"))
            .unwrap()
            .try_into()
            .unwrap();
        builder.data_store_identifier(bytes)
    }
    #[cfg(not(target_os = "macos"))]
    {
        builder.data_directory(root.join("website-store"))
    }
}
