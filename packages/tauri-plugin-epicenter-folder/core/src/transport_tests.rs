//! Relay handles everywhere; owner transfers through a loopback `git
//! http-backend` with the production transport (HTTP only, every control),
//! skipped with a note where this environment refuses a listener (see
//! `testing::GitHttp`). The runner's own relay checks are in `git.rs`.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use crate::git::Git;
use crate::history::PushOutcome;
use crate::owner::FolderOwner;
use crate::testing::{config, create, git, GitHttp, TempDir};
use crate::transport::{GitService, Relay, Remote, Transport};

const CANONICAL: &str = "https://github.com/alice/notes.git";
const TOKEN: &str = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

fn canonical() -> Remote {
    Remote {
        url: CANONICAL.to_string(),
        branch: "main".to_string(),
    }
}

#[test]
fn a_relay_retires_once_and_reports_once() {
    let count = Arc::new(AtomicUsize::new(0));
    let seen = Arc::clone(&count);
    let relay = Relay::new("http://127.0.0.1:1/x/repo.git", move || {
        seen.fetch_add(1, Ordering::SeqCst);
        Some("GitHub refused this transfer".to_string())
    });
    assert_eq!(relay.url(), "http://127.0.0.1:1/x/repo.git");
    assert_eq!(
        relay.retire().as_deref(),
        Some("GitHub refused this transfer")
    );
    assert_eq!(relay.retire(), None);
    drop(relay);
    assert_eq!(count.load(Ordering::SeqCst), 1);
}

#[test]
fn dropping_an_unretired_relay_retires_it() {
    let count = Arc::new(AtomicUsize::new(0));
    let seen = Arc::clone(&count);
    drop(Relay::new("u", move || {
        seen.fetch_add(1, Ordering::SeqCst);
        None
    }));
    assert_eq!(count.load(Ordering::SeqCst), 1);
}

#[test]
fn a_relay_capability_is_redacted_in_every_spelling_and_never_debug_printed() {
    let url = format!("http://127.0.0.1:39130/_epicenter/git-relay/{TOKEN}/repo.git");
    let relay = Relay::new(url.clone(), || None);
    for (echoed, expected) in [
        (
            format!("fatal: unable to access '{url}/': Failed to connect"),
            format!("fatal: unable to access '{CANONICAL}/': Failed to connect"),
        ),
        (
            format!("remote: see 127.0.0.1:39130/_epicenter/git-relay/{TOKEN}/repo.git"),
            "remote: see [relay]".to_string(),
        ),
        (
            format!("POST /_epicenter/git-relay/{TOKEN}/repo.git/git-upload-pack"),
            "POST [relay]/git-upload-pack".to_string(),
        ),
        (
            format!("remote: token {TOKEN} echoed"),
            "remote: token [relay] echoed".to_string(),
        ),
        (
            "error: RPC failed; HTTP 502".to_string(),
            "error: RPC failed; HTTP 502".to_string(),
        ),
    ] {
        assert_eq!(relay.redact(&echoed, CANONICAL), expected);
    }
    let debug = format!("{relay:?}");
    assert!(
        !debug.contains(TOKEN) && !debug.contains("39130"),
        "{debug}"
    );
}

type Journal = Arc<Mutex<Vec<String>>>;

/// A transport whose relay reaches `url`, recording what it was asked for.
#[derive(Debug)]
struct RecordingTransport {
    url: String,
    journal: Journal,
    refuse: Option<String>,
    /// What each relay reports when retired: `None` confirms the transfer.
    report: Option<String>,
}

impl Transport for RecordingTransport {
    fn start(&self, root: &Path, remote: &Remote, service: GitService) -> Result<Relay, String> {
        assert!(root.is_absolute());
        self.journal
            .lock()
            .unwrap()
            .push(format!("start {} {}", service.as_str(), remote.url));
        if let Some(refusal) = &self.refuse {
            return Err(refusal.clone());
        }
        let journal = Arc::clone(&self.journal);
        let report = self.report.clone();
        Ok(Relay::new(self.url.clone(), move || {
            journal
                .lock()
                .unwrap()
                .push(format!("retire {}", service.as_str()));
            report
        }))
    }
}

/// An empty bare repository at `path` inside a served project.
fn bare_at(project: &Path, path: &str) -> PathBuf {
    let bare = project.join(path);
    fs::create_dir_all(&bare).unwrap();
    git(
        &bare,
        &["init", "--quiet", "--bare", "--initial-branch=main"],
    );
    bare
}

fn owner_with(temp: &TempDir, transport: RecordingTransport) -> FolderOwner {
    let root = temp.folder("folder");
    let mut folder = config(&root);
    folder.remote = Some(canonical());
    folder.transport = Some(Arc::new(transport));
    FolderOwner::open(folder).unwrap()
}

#[test]
fn an_injected_transport_carries_push_and_fetch_while_origin_stays_canonical() {
    let temp = TempDir::new("transport-owner");
    let project = temp.folder("served");
    let path = format!("{TOKEN}/repo.git");
    let bare = bare_at(&project, &path);
    let Some(http) = GitHttp::start("an_injected_transport_carries_push_and_fetch", &project)
    else {
        return;
    };
    let journal: Journal = Arc::default();
    let owner = owner_with(
        &temp,
        RecordingTransport {
            url: http.url(&path),
            journal: Arc::clone(&journal),
            refuse: None,
            report: None,
        },
    );
    owner.apply(&[create("notes/a.md", "hello")]).unwrap();
    owner.commit();
    let outcome = owner.push(None);
    let PushOutcome::Pushed { oid } = outcome else {
        panic!("pushed through the relay, not {outcome:?}");
    };
    assert_eq!(git(&bare, &["rev-parse", "main"]), oid);
    assert_eq!(owner.fetch(None).unwrap().oid, Some(oid));
    assert_eq!(
        *journal.lock().unwrap(),
        vec![
            format!("start git-receive-pack {CANONICAL}"),
            "retire git-receive-pack".to_string(),
            format!("start git-upload-pack {CANONICAL}"),
            "retire git-upload-pack".to_string(),
        ]
    );
    let requests = http.requests();
    assert!(requests.iter().any(|r| r.contains("git-receive-pack")));
    assert!(requests.iter().all(|r| r.contains(&format!("/{path}/"))));
    // The relay is nowhere in what the folder reports or stores.
    assert_eq!(owner.snapshot().remote.as_ref().unwrap().url, CANONICAL);
    let stored = fs::read_to_string(owner.root().join(".git/config")).unwrap();
    assert!(!stored.contains(TOKEN), "{stored}");
    owner.shutdown();
}

#[test]
fn a_transport_that_refuses_stops_the_transfer_and_not_the_editing() {
    let temp = TempDir::new("transport-refused");
    let journal: Journal = Arc::default();
    let owner = owner_with(
        &temp,
        RecordingTransport {
            url: "http://127.0.0.1:9/unused/repo.git".to_string(),
            journal: Arc::clone(&journal),
            refuse: Some("This folder is not connected to a repository".to_string()),
            report: None,
        },
    );
    owner.apply(&[create("a.md", "a")]).unwrap();
    owner.commit();
    let outcome = owner.push(None);
    let PushOutcome::Failed { error, .. } = outcome else {
        panic!("a refused push, not {outcome:?}");
    };
    assert_eq!(error, "This folder is not connected to a repository");
    assert!(owner.fetch(None).is_err());
    // Editing and local history carry on.
    owner.apply(&[create("b.md", "b")]).unwrap();
    assert_eq!(fs::read_to_string(owner.root().join("b.md")).unwrap(), "b");
    owner.shutdown();
}

/// Git exits 0, but the relay's retirement reports that the transfer could
/// not be confirmed (its account was disposed, or upstream refused part of
/// it). The push is not reported as pushed and the fetch not as fetched; the
/// history Git moved is left exactly as it is, and nothing is retried.
#[test]
fn a_successful_git_transfer_its_transport_cannot_confirm_is_not_reported_done() {
    let temp = TempDir::new("transport-unconfirmed");
    let project = temp.folder("served");
    let path = format!("{TOKEN}/repo.git");
    let bare = bare_at(&project, &path);
    let Some(http) = GitHttp::start(
        "a_successful_git_transfer_its_transport_cannot_confirm",
        &project,
    ) else {
        return;
    };
    let journal: Journal = Arc::default();
    let owner = owner_with(
        &temp,
        RecordingTransport {
            url: http.url(&path),
            journal: Arc::clone(&journal),
            refuse: None,
            report: Some(
                "Its connection had already ended before Epicenter could confirm it.".to_string(),
            ),
        },
    );
    owner.apply(&[create("notes/a.md", "hello")]).unwrap();
    owner.commit();
    let head = git(owner.root(), &["rev-parse", "main"]);
    let outcome = owner.push(None);
    let PushOutcome::Unconfirmed { error } = outcome else {
        panic!("an unconfirmed push, not {outcome:?}");
    };
    assert!(error.contains("may or may not have landed"), "{error}");
    assert!(error.contains("already ended"), "{error}");
    assert!(!error.contains(TOKEN), "{error}");
    // What Git sent stays sent; local history is untouched.
    assert_eq!(git(&bare, &["rev-parse", "main"]), head);
    assert_eq!(git(owner.root(), &["rev-parse", "main"]), head);

    let fetched = owner.fetch(None).unwrap_err();
    let message = format!("{fetched:?}");
    assert!(message.contains("not reported as fetched"), "{message}");
    assert_eq!(
        journal
            .lock()
            .unwrap()
            .iter()
            .filter(|entry| entry.starts_with("start"))
            .count(),
        2,
        "nothing was retried"
    );
    owner.shutdown();
}

/// Hostile repository configuration against the production transport: a
/// prefix rewrite to another repository on the same server, a dead proxy,
/// hooks, and fsmonitor. With the controls Git reaches only the relay and
/// runs nothing; without them the same fixture misleads it.
#[cfg(unix)]
#[test]
fn hostile_repository_configuration_cannot_redirect_a_relayed_fetch_or_run_code() {
    use std::os::unix::fs::PermissionsExt;

    let temp = TempDir::new("transport-hostile");
    let project = temp.folder("served");
    let path = format!("{TOKEN}/repo.git");
    let relay_repository = bare_at(&project, &path);
    let evil = bare_at(&project, &format!("evil/{path}"));
    let Some(http) = GitHttp::start("hostile_repository_configuration", &project) else {
        return;
    };
    for (repository, text) in [(&relay_repository, "relay"), (&evil, "evil")] {
        let work = temp.folder(&format!("seed-{text}"));
        git(&work, &["init", "--quiet", "--initial-branch=main"]);
        fs::write(work.join("who.md"), text).unwrap();
        git(&work, &["add", "who.md"]);
        git(&work, &["commit", "--quiet", "-m", text]);
        git(
            &work,
            &["push", "--quiet", repository.to_str().unwrap(), "main"],
        );
    }
    let root = temp.folder("hostile");
    let fetching = Git::open(&root, "main", Some(canonical())).unwrap();
    let markers = temp.folder("markers");
    let hooks = temp.folder("hooks");
    let script = |name: &str| {
        let path = hooks.join(name);
        fs::write(
            &path,
            format!(
                "#!/bin/sh\ntouch '{}'\nexit 0\n",
                markers.join(name).display()
            ),
        )
        .unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        path
    };
    script("reference-transaction");
    let fsmonitor = script("fsmonitor");
    // Written before the transfer, so it cannot know the relay's token: it
    // rewrites the whole server to the same paths under `evil/`.
    let rewrite = format!("url.{}.insteadOf", http.url("evil/"));
    git(&root, &["config", &rewrite, &http.url("")]);
    git(&root, &["config", "http.proxy", "http://127.0.0.1:9"]);
    git(
        &root,
        &["config", "core.hooksPath", hooks.to_str().unwrap()],
    );
    git(
        &root,
        &["config", "core.fsmonitor", fsmonitor.to_str().unwrap()],
    );
    let journal: Journal = Arc::default();
    let retired = Arc::clone(&journal);
    let relay = Relay::new(http.url(&path), move || {
        retired.lock().unwrap().push("retired".to_string());
        None
    });

    let fetched = fetching
        .fetch(&AtomicBool::new(false), Some(&relay))
        .unwrap();

    assert_eq!(
        fetched,
        Some(git(&relay_repository, &["rev-parse", "main"]))
    );
    assert_eq!(
        fs::read_dir(&markers).unwrap().count(),
        0,
        "no hook or fsmonitor ran"
    );
    assert!(http.requests().iter().all(|r| !r.contains("/evil/")));
    drop(relay);
    assert_eq!(*journal.lock().unwrap(), vec!["retired"]);

    // The same fixture without the controls really is hostile: the proxy
    // stops it, and without the proxy the rewrite wins and hooks run.
    let direct = Git::open(
        &root,
        "main",
        Some(Remote {
            url: http.url(&path),
            branch: "main".to_string(),
        }),
    )
    .unwrap();
    assert!(direct.fetch(&AtomicBool::new(false), None).is_err());
    git(&root, &["config", "--unset", "http.proxy"]);
    assert_eq!(
        direct.fetch(&AtomicBool::new(false), None).unwrap(),
        Some(git(&evil, &["rev-parse", "main"]))
    );
    assert!(markers.join("reference-transaction").exists());
}

/// A transfer the server holds in flight is cancelled: the cancel path
/// retires the relay before Git is stopped.
#[test]
fn a_cancelled_transfer_in_flight_retires_its_relay_before_git_is_stopped() {
    let temp = TempDir::new("transport-cancel");
    let project = temp.folder("served");
    let path = format!("{TOKEN}/repo.git");
    bare_at(&project, &path);
    let Some(http) = GitHttp::start("a_cancelled_transfer_in_flight", &project) else {
        return;
    };
    http.stall();
    let root = temp.folder("folder");
    let fetching = Git::open(&root, "main", Some(canonical())).unwrap();
    let journal: Journal = Arc::default();
    let retired = Arc::clone(&journal);
    let end_requests = http.retirement();
    let relay = Relay::new(http.url(&path), move || {
        retired.lock().unwrap().push("retired".to_string());
        end_requests();
        None
    });
    let cancel = Arc::new(AtomicBool::new(false));
    let cancelling = Arc::clone(&cancel);
    let waiter = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(300));
        cancelling.store(true, Ordering::SeqCst);
    });
    let started = std::time::Instant::now();
    assert!(fetching.fetch(&cancel, Some(&relay)).is_err());
    waiter.join().unwrap();
    assert!(started.elapsed() < std::time::Duration::from_secs(10));
    assert_eq!(*journal.lock().unwrap(), vec!["retired"]);
    assert!(!http.requests().is_empty(), "the transfer was in flight");
    assert_eq!(fetching.read_remote_tracking().unwrap(), None);
}
