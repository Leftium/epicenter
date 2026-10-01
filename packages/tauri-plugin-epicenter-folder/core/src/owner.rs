//! The one owner of a native folder.
//!
//! Every window of a shell shares one `FolderOwner` per root, so they share
//! one ordering of saves, one Git snapshot, and one queue of commit passes.
//! The owner outlives any window: a save it admitted lands and is committed
//! whether or not the page that asked is still there.
//!
//! Two independent gates order its work, and they are never held together in
//! the wrong order:
//!
//! - The **file gate** admits one publication at a time: a complete `apply`
//!   batch, a directory change, or a fast-forward's file changes. A terminal
//!   lease holds it across several calls, for at most `lease_limit`.
//! - The **Git lock** serializes work on the index and the branch: commit
//!   passes, staging, staged commits, and a fast-forward's ref update.
//!
//! A commit pass pins the branch head, takes the file gate just long enough
//! to enumerate the folder and hard-link every file into a snapshot, and
//! releases it. Only then does it wait for the Git lock, where it checks the
//! head is still the one it pinned, hashes the snapshot, and publishes. So a
//! save never waits for hashing or for other Git work, and no batch of this
//! owner is ever seen half applied. A save that lands after the snapshot is
//! simply newer than it: the observation is marked stale and the save's own
//! request starts another pass after this one. If the head moved before the
//! pass reached the Git lock, the pass starts over with a fresh snapshot
//! rather than commit old bytes on a new parent.
//!
//! The snapshot is exact against this owner's own writes, which replace files
//! by rename or link. A program that edits a file in place can still change
//! bytes the snapshot links to: that stays best effort.
//!
//! A fast-forward takes the file gate, then the Git lock. Nothing takes them
//! in the other order, and nothing waits for the Git lock while it holds the
//! file gate.
//!
//! Network work runs outside both. Listeners are called with a copy of the
//! listener list; the plugin's listener only queues the event.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use unicode_normalization::UnicodeNormalization;

use crate::files::{
    resolve_root, verify_layout, ApplyError, Children, FileChange, FileError, FileExpectation,
    FileListing, FileRead, FileStep, FileVersion, Files,
};
use crate::git::{Author, Capture, Cas, CommitSummary, Git, IndexCommit, PathStatus, Remote};
use crate::history::{
    Activities, Activity, Attempt, CommitOutcome, CommitPass, FetchOutcome, FilesObservation,
    GitError, GitSnapshot, Observation, OwnerEvent, PullError, PullOutcome, PushOutcome,
    SyncObservation,
};
use crate::messages::{commit_subject, message_problem, ChangeKind};
use crate::paths::{ancestors, is_portable_path, path_problem};
use crate::runner::{CloseMode, Endings, PassRunner};

/// How many fresh snapshots one commit pass takes when the branch keeps
/// moving underneath it.
const CAPTURE_ATTEMPTS: usize = 3;

#[derive(Debug, Clone)]
pub struct FolderConfig {
    /// The folder's directory, chosen by the shell. A Git repository is
    /// initialized there if absent.
    pub root: PathBuf,
    /// The local branch history is recorded on.
    pub branch: String,
    /// Author and committer for automatic and staged commits.
    pub author: Author,
    pub remote: Option<Remote>,
    /// Whether complete content saves request automatic commits and pushes.
    pub commit_on_edit: bool,
    /// Whether the repository's own `user.name` and `user.email` decide who
    /// commits. They are read once, when the folder opens, after its lock is
    /// held and its layout verified; `author` supplies whichever of the two
    /// is not configured.
    pub use_repository_author: bool,
    /// Whether the repository's own `remote.origin.url` decides where history
    /// is pushed and fetched. It is read at the same point as the author. A
    /// repository with no `origin` keeps `remote`, which is honored whether
    /// or not this is set. The branch stays `branch`.
    ///
    /// This is separate from the author because a configured remote makes
    /// automatic commits push: a folder that should stay local reads the
    /// author and leaves this off.
    pub use_repository_origin: bool,
    /// Whether filesystem events are watched, so a change made outside the
    /// owner is noticed at once, even one that leaves size and time as they
    /// were. Where watching is unavailable the owner says so and relies on
    /// `watch_interval`.
    pub watch_events: bool,
    /// How often the owner compares file sizes and times to find changes made
    /// outside it, whether or not an event announced them. `None` disables
    /// the periodic check; `poll_external` still works.
    pub watch_interval: Option<Duration>,
    /// The longest a terminal lease may hold the file gate.
    pub lease_limit: Duration,
}

impl FolderConfig {
    pub fn new(root: impl Into<PathBuf>, author: Author) -> Self {
        Self {
            root: root.into(),
            branch: "main".to_string(),
            author,
            remote: None,
            commit_on_edit: true,
            use_repository_author: false,
            use_repository_origin: false,
            watch_events: true,
            watch_interval: Some(Duration::from_secs(2)),
            lease_limit: Duration::from_secs(60),
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Case- and Unicode-folded spelling used only to detect destinations that
/// cannot coexist on case-insensitive filesystems. Never used for lookup.
fn collision_key(path: &str) -> String {
    path.nfc().collect::<String>().to_lowercase()
}

// ============================================================================
// The file gate
// ============================================================================

enum Holder {
    Free,
    /// One publication.
    Batch,
    /// A terminal lease, across several of its own calls.
    Lease {
        id: u64,
        deadline: Instant,
        /// Released, expired, or revoked: no new call may use it, and the
        /// gate frees once its calls in flight settle.
        ended: bool,
        in_flight: usize,
    },
}

struct Gate {
    holder: Mutex<Holder>,
    changed: Condvar,
    next_lease: AtomicU64,
}

enum Permit<'a> {
    Batch(&'a Gate),
    Leased(&'a Gate),
}

impl Drop for Permit<'_> {
    fn drop(&mut self) {
        match self {
            Permit::Batch(gate) => *lock(&gate.holder) = Holder::Free,
            Permit::Leased(gate) => {
                if let Holder::Lease { in_flight, .. } = &mut *lock(&gate.holder) {
                    *in_flight -= 1;
                }
            }
        }
        let (Permit::Batch(gate) | Permit::Leased(gate)) = self;
        gate.changed.notify_all();
    }
}

impl Gate {
    fn new() -> Self {
        Self {
            holder: Mutex::new(Holder::Free),
            changed: Condvar::new(),
            next_lease: AtomicU64::new(1),
        }
    }

    /// Wait until no batch or live lease holds the gate, then leave it free.
    fn wait_free<'a>(&'a self, mut holder: MutexGuard<'a, Holder>) -> MutexGuard<'a, Holder> {
        loop {
            let wait = match &mut *holder {
                Holder::Free => return holder,
                Holder::Batch => None,
                Holder::Lease {
                    deadline,
                    ended,
                    in_flight,
                    ..
                } => {
                    let now = Instant::now();
                    if now >= *deadline {
                        *ended = true;
                    }
                    if *ended && *in_flight == 0 {
                        // Fall through to free the gate below.
                        Some(Duration::ZERO)
                    } else {
                        // An ended lease frees when its calls settle, which notifies.
                        (!*ended).then(|| *deadline - now)
                    }
                }
            };
            holder = match wait {
                Some(Duration::ZERO) => {
                    *holder = Holder::Free;
                    return holder;
                }
                None => self
                    .changed
                    .wait(holder)
                    .unwrap_or_else(|poisoned| poisoned.into_inner()),
                Some(until_deadline) => {
                    self.changed
                        .wait_timeout(holder, until_deadline)
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .0
                }
            };
        }
    }

    /// Enter for one publication. A call that names the lease holding the
    /// gate runs inside it; a call that names any other lease is refused.
    fn enter(&self, lease: Option<u64>) -> Result<Permit<'_>, FileError> {
        let mut holder = lock(&self.holder);
        let Some(lease) = lease else {
            let mut holder = self.wait_free(holder);
            *holder = Holder::Batch;
            return Ok(Permit::Batch(self));
        };
        match &mut *holder {
            Holder::Lease {
                id,
                deadline,
                ended,
                in_flight,
            } if *id == lease && !*ended && Instant::now() < *deadline => {
                *in_flight += 1;
                Ok(Permit::Leased(self))
            }
            _ => Err(FileError::LeaseEnded {
                reason: "the terminal lease was released or reached its time limit".to_string(),
            }),
        }
    }

    /// Enter for a shared pass. A pass has no caller of its own, so it runs
    /// inside a lease only while the lease holder is the one waiting for it:
    /// `vouched` names that lease. Otherwise it waits like any publication.
    fn enter_pass(&self, vouched: &dyn Fn() -> Option<u64>) -> Permit<'_> {
        loop {
            if let Some(lease) = vouched() {
                if let Ok(permit) = self.enter(Some(lease)) {
                    return permit;
                }
            }
            let mut holder = lock(&self.holder);
            if matches!(*holder, Holder::Free) {
                *holder = Holder::Batch;
                return Permit::Batch(self);
            }
            // Wake for a freed gate, and look again for a lease that now vouches.
            drop(
                self.changed
                    .wait_timeout(holder, Duration::from_millis(20))
                    .unwrap_or_else(|poisoned| poisoned.into_inner()),
            );
            // An expired lease is ended by whoever waits on it.
            self.end_expired_lease();
        }
    }

    fn end_expired_lease(&self) {
        let mut holder = lock(&self.holder);
        if let Holder::Lease {
            deadline,
            ended,
            in_flight,
            ..
        } = &mut *holder
        {
            if Instant::now() >= *deadline {
                *ended = true;
            }
            if *ended && *in_flight == 0 {
                *holder = Holder::Free;
            }
        }
    }

    fn lease(&self, limit: Duration) -> u64 {
        let mut holder = self.wait_free(lock(&self.holder));
        let id = self.next_lease.fetch_add(1, Ordering::SeqCst);
        *holder = Holder::Lease {
            id,
            deadline: Instant::now() + limit,
            ended: false,
            in_flight: 0,
        };
        id
    }

    /// End a lease. `None` ends whichever lease holds the gate.
    fn end_lease(&self, lease: Option<u64>) {
        let mut holder = lock(&self.holder);
        if let Holder::Lease {
            id,
            ended,
            in_flight,
            ..
        } = &mut *holder
        {
            if lease.is_none_or(|lease| lease == *id) {
                *ended = true;
                if *in_flight == 0 {
                    *holder = Holder::Free;
                }
            }
        }
        drop(holder);
        self.changed.notify_all();
    }
}

// ============================================================================
// Owner state
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Stamp {
    size: u64,
    modified: Option<u128>,
}

#[derive(Default)]
struct Watch {
    primed: bool,
    stamps: BTreeMap<String, Stamp>,
    refs: String,
}

/// What filesystem events have announced since the watcher last looked.
#[derive(Default)]
struct Hints {
    paths: BTreeSet<String>,
    /// `HEAD`, the index, or a ref changed.
    git: bool,
}

struct HistoryState {
    /// Orders captures against edits. An observation captured at `n` is stale
    /// once an edit lands at a later tick.
    clock: u64,
    last_edit: u64,
    files: Observation<FilesObservation>,
    files_captured_at: u64,
    sync: Observation<SyncObservation>,
    last_commit: Option<Attempt<CommitOutcome>>,
    last_push: Option<Attempt<PushOutcome>>,
    last_fetch: Option<Attempt<Result<FetchOutcome, GitError>>>,
    last_pull: Option<Attempt<Result<PullOutcome, PullError>>>,
    remote_sequence: u64,
    /// Whether the next commit pass was requested by a content save. Consumed
    /// when a pass starts; only such passes push afterward.
    automatic_queued: bool,
    /// The terminal lease whose holder is waiting on a pass, if any. A pass
    /// that needs the file gate runs inside that lease instead of behind it.
    waiting_lease: Option<u64>,
}

type Listener = Arc<dyn Fn(&OwnerEvent) + Send + Sync>;

struct Emitted {
    sequence: u64,
    snapshot: Arc<GitSnapshot>,
}

#[cfg(test)]
#[derive(Default)]
pub(crate) struct Hooks {
    /// Runs inside an admitted `apply`, before the file gate.
    pub before_apply: Option<Arc<dyn Fn() + Send + Sync>>,
    /// Runs inside a commit pass while it holds the file gate, before it
    /// snapshots the folder.
    pub during_snapshot: Option<Arc<dyn Fn() + Send + Sync>>,
    /// Runs inside a commit pass after the gate is released, before the pass
    /// takes the Git lock.
    pub after_snapshot: Option<Arc<dyn Fn() + Send + Sync>>,
    /// Runs inside a commit pass under the Git lock, once the parent is
    /// confirmed, before the snapshot is hashed.
    pub before_hash: Option<Arc<dyn Fn() + Send + Sync>>,
    /// Runs inside a commit pass under the Git lock, after the snapshot was
    /// hashed, before the commit is published.
    pub after_capture: Option<Arc<dyn Fn() + Send + Sync>>,
    /// Runs inside a fast-forward after the folder was found clean, before
    /// its file changes are built.
    pub during_pull: Option<Arc<dyn Fn() + Send + Sync>>,
}

struct Inner {
    config: FolderConfig,
    root: PathBuf,
    files: Files,
    git: Git,
    gate: Gate,
    git_lock: Mutex<()>,
    state: Mutex<HistoryState>,
    emitted: Mutex<Emitted>,
    listeners: Mutex<Vec<(u64, Listener)>>,
    next_listener: AtomicU64,
    /// Counts admitted file and explicit Git operations still running.
    admitted: Mutex<usize>,
    settled: Condvar,
    /// New work is refused.
    closing: AtomicBool,
    /// Admitted work has drained; saves no longer request commits.
    finishing: AtomicBool,
    shutdown: Mutex<bool>,
    revision: AtomicU64,
    own_in_flight: AtomicUsize,
    own_done: AtomicU64,
    watch: Mutex<Watch>,
    watching: Arc<AtomicBool>,
    hints: Mutex<Hints>,
    hinted: Condvar,
    /// The filesystem watcher, until shutdown releases it.
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
    /// Why filesystem events are not being watched, when they are not.
    watch_diagnostic: Mutex<Option<String>>,
    scan: PassRunner<Result<FilesObservation, GitError>>,
    commit: PassRunner<CommitPass>,
    push: PassRunner<PushOutcome>,
    fetch: PassRunner<Result<FetchOutcome, GitError>>,
    pull: PassRunner<Result<PullOutcome, PullError>>,
    #[cfg(test)]
    hooks: Mutex<Hooks>,
    /// How many relevant announcements arrived, for telling "no event came"
    /// from "an event came and was ignored" in tests.
    #[cfg(test)]
    announced: AtomicU64,
}

struct Admission<'a>(&'a Inner);

impl Drop for Admission<'_> {
    fn drop(&mut self) {
        *lock(&self.0.admitted) -= 1;
        self.0.settled.notify_all();
    }
}

struct Waiting<'a>(&'a Inner, u64);

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        let mut state = lock(&self.0.state);
        if state.waiting_lease == Some(self.1) {
            state.waiting_lease = None;
        }
    }
}

/// A lease holder's wait on a shared pass; see `FolderOwner::vouch`.
pub struct Vouched<'a>(#[allow(dead_code)] Option<Waiting<'a>>);

/// Stops listening when dropped.
pub struct Subscription {
    owner: Weak<Inner>,
    id: u64,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.upgrade() {
            lock(&owner.listeners).retain(|(id, _)| *id != self.id);
        }
    }
}

/// A held terminal lease. Dropping it releases the file gate.
pub struct Lease {
    owner: Weak<Inner>,
    id: u64,
}

impl Lease {
    pub fn id(&self) -> u64 {
        self.id
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.upgrade() {
            owner.gate.end_lease(Some(self.id));
        }
    }
}

#[derive(Clone)]
pub struct FolderOwner {
    inner: Arc<Inner>,
}

fn pass<T: Clone + Send + 'static>(
    name: &str,
    owner: &Weak<Inner>,
    endings: Endings<T>,
    run: fn(&Inner, &AtomicBool) -> T,
) -> PassRunner<T> {
    let closed = endings.closed;
    let running = owner.clone();
    let changed = owner.clone();
    PassRunner::new(
        name,
        endings,
        move |cancel| match running.upgrade() {
            Some(inner) => run(&inner, cancel),
            None => closed(),
        },
        move || {
            if let Some(inner) = changed.upgrade() {
                inner.emit();
            }
        },
    )
}

impl FolderOwner {
    /// Open the folder at `config.root`. The caller already holds the
    /// cross-process lock for the canonical root.
    pub fn open(mut config: FolderConfig) -> Result<Self, String> {
        let root = resolve_root(&config.root)?;
        // Before any Git command, including the configuration reads below: a
        // linked `.git` would send them to someone else's repository.
        verify_layout(&root)?;
        let mut git = Git::open(&root, &config.branch, config.remote.clone())?;
        // `git init` may just have created the private layout; check what it left.
        verify_layout(&root)?;
        // A directory someone already gave an identity or a remote keeps
        // them, as the `git` command line would, where the shell asked for
        // that. Each is asked for on its own.
        if config.use_repository_author {
            if let Some(name) = git.configured("user.name")? {
                config.author.name = name;
            }
            if let Some(email) = git.configured("user.email")? {
                config.author.email = email;
            }
        }
        if config.use_repository_origin {
            if let Some(url) = git.configured("remote.origin.url")? {
                config.remote = Some(Remote {
                    url,
                    branch: config.branch.clone(),
                });
                git = Git::open(&root, &config.branch, config.remote.clone())?;
            }
        }
        git.clear_snapshots();
        let watching = Arc::new(AtomicBool::new(true));
        let inner = Arc::new_cyclic(|owner: &Weak<Inner>| Inner {
            files: Files::new(&root),
            gate: Gate::new(),
            git_lock: Mutex::new(()),
            state: Mutex::new(HistoryState {
                clock: 0,
                last_edit: 0,
                files: Observation::Unknown { error: None },
                files_captured_at: 0,
                sync: Observation::Unknown { error: None },
                last_commit: None,
                last_push: None,
                last_fetch: None,
                last_pull: None,
                remote_sequence: 0,
                automatic_queued: false,
                waiting_lease: None,
            }),
            emitted: Mutex::new(Emitted {
                sequence: 0,
                snapshot: Arc::new(GitSnapshot {
                    branch: git.branch.clone(),
                    remote: git.remote.clone(),
                    commit_on_edit: config.commit_on_edit,
                    files: Observation::Unknown { error: None },
                    sync: Observation::Unknown { error: None },
                    activity: Activities::default(),
                    last_commit: None,
                    last_push: None,
                    last_fetch: None,
                    last_pull: None,
                    closed: false,
                }),
            }),
            listeners: Mutex::new(Vec::new()),
            next_listener: AtomicU64::new(1),
            admitted: Mutex::new(0),
            settled: Condvar::new(),
            closing: AtomicBool::new(false),
            finishing: AtomicBool::new(false),
            shutdown: Mutex::new(false),
            revision: AtomicU64::new(0),
            own_in_flight: AtomicUsize::new(0),
            own_done: AtomicU64::new(0),
            watch: Mutex::new(Watch::default()),
            watching: Arc::clone(&watching),
            hints: Mutex::new(Hints::default()),
            hinted: Condvar::new(),
            watcher: Mutex::new(None),
            watch_diagnostic: Mutex::new(None),
            scan: pass(
                "scan",
                owner,
                Endings {
                    failed: |cause| Err(GitError::failed("status", cause)),
                    closed: || Err(GitError::Closed),
                    cancelled: || Err(GitError::Closed),
                },
                |inner, _| inner.run_scan(),
            ),
            commit: pass(
                "commit",
                owner,
                Endings {
                    // A pass that panicked may already have moved the branch.
                    failed: |error| CommitPass {
                        outcome: CommitOutcome::Unconfirmed { error },
                        following_push: None,
                    },
                    closed: || CommitPass {
                        outcome: CommitOutcome::Closed,
                        following_push: None,
                    },
                    cancelled: || CommitPass {
                        outcome: CommitOutcome::Closed,
                        following_push: None,
                    },
                },
                |inner, _| inner.run_commit(),
            ),
            push: pass(
                "push",
                owner,
                Endings {
                    // A pass that panicked may already have sent the commit.
                    failed: |error| PushOutcome::Unconfirmed { error },
                    closed: || PushOutcome::Closed,
                    cancelled: || PushOutcome::Cancelled { oid: None },
                },
                Inner::run_push,
            ),
            fetch: pass(
                "fetch",
                owner,
                Endings {
                    failed: |cause| Err(GitError::failed("fetch", cause)),
                    closed: || Err(GitError::Closed),
                    cancelled: || Err(GitError::Closed),
                },
                Inner::run_fetch,
            ),
            pull: pass(
                "pull",
                owner,
                Endings {
                    failed: |cause| Err(GitError::failed("pull", cause).into()),
                    closed: || Err(GitError::Closed.into()),
                    cancelled: || Err(GitError::Closed.into()),
                },
                |inner, _| inner.run_pull(),
            ),
            #[cfg(test)]
            hooks: Mutex::new(Hooks::default()),
            #[cfg(test)]
            announced: AtomicU64::new(0),
            git,
            root,
            config,
        });
        inner.poll_external();
        if inner.config.watch_events {
            if let Err(cause) = inner.watch_events(Arc::downgrade(&inner)) {
                // Not fatal: the periodic comparison still finds most changes.
                // It cannot see an edit that restores size and time, so say so.
                let diagnostic = format!(
                    "filesystem events are not being watched for {}: {cause}; outside changes are found by periodic comparison only",
                    inner.root.display()
                );
                log::warn!("{diagnostic}");
                *lock(&inner.watch_diagnostic) = Some(diagnostic);
            }
        }
        if inner.config.watch_events || inner.config.watch_interval.is_some() {
            let owner = Arc::downgrade(&inner);
            let interval = inner.config.watch_interval;
            std::thread::Builder::new()
                .name("folder-watch".to_string())
                .spawn(move || {
                    let mut compared = Instant::now();
                    while watching.load(Ordering::SeqCst) {
                        let Some(inner) = owner.upgrade() else { return };
                        let announced = {
                            let hints = lock(&inner.hints);
                            let wait = interval
                                .map(|interval| interval.saturating_sub(compared.elapsed()))
                                .unwrap_or(Duration::from_millis(500))
                                .min(Duration::from_millis(500));
                            let mut hints = if hints.paths.is_empty() && !hints.git {
                                inner
                                    .hinted
                                    .wait_timeout(hints, wait)
                                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                                    .0
                            } else {
                                hints
                            };
                            std::mem::take(&mut *hints)
                        };
                        if !watching.load(Ordering::SeqCst) {
                            return;
                        }
                        if !announced.paths.is_empty() || announced.git {
                            inner.heed(announced);
                        }
                        if interval.is_some_and(|interval| compared.elapsed() >= interval) {
                            compared = Instant::now();
                            inner.poll_external();
                        }
                    }
                })
                .map_err(|cause| format!("the folder watcher could not start: {cause}"))?;
        }
        Ok(Self { inner })
    }

    /// Why filesystem events are not being watched, if they were asked for
    /// and could not be. Changes are then found by periodic comparison only.
    pub fn watch_diagnostic(&self) -> Option<String> {
        lock(&self.inner.watch_diagnostic).clone()
    }

    /// Who commits, after the repository's own configuration was applied.
    pub fn author(&self) -> &Author {
        &self.inner.config.author
    }

    /// The canonical root this owner holds.
    pub fn root(&self) -> &Path {
        &self.inner.root
    }

    pub fn snapshot(&self) -> Arc<GitSnapshot> {
        Arc::clone(&lock(&self.inner.emitted).snapshot)
    }

    /// The current snapshot with its sequence number. A listener that
    /// subscribed first can drop any event numbered at or below it.
    pub fn sequenced_snapshot(&self) -> (u64, Arc<GitSnapshot>) {
        let emitted = lock(&self.inner.emitted);
        (emitted.sequence, Arc::clone(&emitted.snapshot))
    }

    /// Hear every later event. The current snapshot comes from `snapshot`.
    pub fn subscribe(
        &self,
        listener: impl Fn(&OwnerEvent) + Send + Sync + 'static,
    ) -> Subscription {
        let id = self.inner.next_listener.fetch_add(1, Ordering::SeqCst);
        lock(&self.inner.listeners).push((id, Arc::new(listener)));
        Subscription {
            owner: Arc::downgrade(&self.inner),
            id,
        }
    }

    // ------------------------------------------------------------------
    // Files
    // ------------------------------------------------------------------

    pub fn list(&self) -> Result<FileListing, FileError> {
        let _admitted = self.inner.admit()?;
        self.inner.files.list()
    }

    pub fn children(&self, directory: &str) -> Result<Children, FileError> {
        let _admitted = self.inner.admit()?;
        self.inner.files.children(directory)
    }

    pub fn read(&self, path: &str) -> Result<FileRead, FileError> {
        let _admitted = self.inner.admit()?;
        self.inner.files.read(path)
    }

    /// Reads several files; a missing or unreadable path is reported by path.
    pub fn read_many(
        &self,
        paths: &[String],
    ) -> Result<Vec<Result<FileRead, FileError>>, FileError> {
        let _admitted = self.inner.admit()?;
        Ok(paths
            .iter()
            .map(|path| self.inner.files.read(path))
            .collect())
    }

    /// Publish ordered changes. A complete batch requests an automatic commit
    /// before this returns; a partial one only marks observations stale.
    pub fn apply(&self, changes: &[FileChange], lease: Option<u64>) -> Result<(), ApplyError> {
        let refused = |error| ApplyError::Refused { error };
        let _admitted = self.inner.admit().map_err(refused)?;
        Files::validate(changes).map_err(refused)?;
        #[cfg(test)]
        self.inner.hook(|hooks| &hooks.before_apply);
        let result = {
            let _permit = self.inner.gate.enter(lease).map_err(refused)?;
            self.inner.publish(changes)
        };
        match &result {
            Ok(()) => {
                let steps: Vec<FileStep> = changes.iter().map(FileChange::step).collect();
                self.inner.edited(&steps);
                self.inner.request_automatic_commit();
            }
            Err(ApplyError::Partial { applied, .. }) => self.inner.edited(applied),
            // The owner itself always knows what it published; `Unconfirmed`
            // is what a caller reports when it lost track of this call.
            Err(ApplyError::Refused { .. } | ApplyError::Unconfirmed { .. }) => {}
        }
        result
    }

    /// Directory changes are not content: they request no commit.
    pub fn mkdir(&self, path: &str, lease: Option<u64>) -> Result<(), FileError> {
        let _admitted = self.inner.admit()?;
        let _permit = self.inner.gate.enter(lease)?;
        self.inner.files.mkdir(path)
    }

    pub fn rmdir(&self, path: &str, lease: Option<u64>) -> Result<(), FileError> {
        let _admitted = self.inner.admit()?;
        let _permit = self.inner.gate.enter(lease)?;
        self.inner.files.rmdir(path)
    }

    /// Hold the file gate across several calls, so a terminal command's reads
    /// and writes see no other publication in between. Every other window's
    /// saves wait, so the lease ends on its own after `lease_limit`.
    pub fn lease(&self) -> Result<Lease, FileError> {
        let _admitted = self.inner.admit()?;
        Ok(Lease {
            owner: Arc::downgrade(&self.inner),
            id: self.inner.gate.lease(self.inner.config.lease_limit),
        })
    }

    // ------------------------------------------------------------------
    // Git
    // ------------------------------------------------------------------

    /// A fresh, read-only inspection of uncommitted changes.
    pub fn status(&self) -> Result<FilesObservation, GitError> {
        self.inner.scan.request_and_wait()
    }

    /// Commit current source files if they changed, and reset the index to
    /// the head either way. Never requests a push.
    pub fn commit(&self) -> CommitPass {
        self.inner.commit.request_and_wait()
    }

    /// Say that the holder of `lease` is about to wait on `status`, `commit`,
    /// or `pull_fast_forward`, until the returned value is dropped. Those
    /// passes need the file gate for a moment; without this they would wait
    /// behind the very lease whose holder is waiting for them.
    pub fn vouch(&self, lease: Option<u64>) -> Vouched<'_> {
        Vouched(self.inner.waiting(lease))
    }

    /// Wait for the push pass `joining` names, or request one.
    pub fn push(&self, joining: Option<u64>) -> PushOutcome {
        match joining {
            Some(pass) => self.inner.push.wait(pass),
            None => self.inner.push.request_and_wait(),
        }
    }

    pub fn fetch(&self) -> Result<FetchOutcome, GitError> {
        self.inner.fetch.request_and_wait()
    }

    /// Apply the fetched remote head only as a clean fast-forward.
    pub fn pull_fast_forward(&self) -> Result<PullOutcome, PullError> {
        self.inner.pull.request_and_wait()
    }

    /// Per-path staged and unstaged state, as `git status` reports it.
    pub fn paths(&self) -> Result<Vec<PathStatus>, GitError> {
        self.inner.manual("status", |inner| {
            let _git = lock(&inner.git_lock);
            inner.git.path_status()
        })
    }

    /// Staged authoring requires `commit_on_edit: false`. `None` stages everything.
    pub fn stage(&self, paths: Option<&[String]>) -> Result<(), GitError> {
        if self.inner.closing.load(Ordering::SeqCst) {
            return Err(GitError::Closed);
        }
        if self.inner.config.commit_on_edit {
            return Err(GitError::AutomaticHistory);
        }
        self.inner.manual("add", |inner| {
            let _git = lock(&inner.git_lock);
            inner.git.stage(paths)
        })
    }

    /// Commit staged changes with a user-authored message in manual mode.
    pub fn commit_staged(&self, message: &str) -> Result<(String, Option<String>), GitError> {
        let Ok(_admitted) = self.inner.admit() else {
            return Err(GitError::Closed);
        };
        if self.inner.config.commit_on_edit {
            return Err(GitError::AutomaticHistory);
        }
        self.inner.commit_staged(message)
    }

    pub fn diff(&self, staged: bool, paths: &[String]) -> Result<String, GitError> {
        self.inner.manual("diff", |inner| {
            let _git = lock(&inner.git_lock);
            inner.git.diff(staged, paths)
        })
    }

    pub fn log(&self, depth: u32) -> Result<Vec<CommitSummary>, GitError> {
        self.inner.manual("log", |inner| inner.git.log(depth))
    }

    // ------------------------------------------------------------------
    // Lifetime
    // ------------------------------------------------------------------

    /// Look for changes made outside this owner now, instead of at the next
    /// background check.
    pub fn poll_external(&self) {
        self.inner.poll_external();
    }

    /// Fence new work, cancel network work, and return once every admitted
    /// save and every local pass it requested has settled. A save admitted
    /// before this call still lands and is still committed; it is not pushed.
    pub fn shutdown(&self) {
        let inner = &self.inner;
        let mut done = lock(&inner.shutdown);
        if *done {
            return;
        }
        {
            // Under the admission lock, so no operation is admitted after this.
            let _admitted = lock(&inner.admitted);
            inner.closing.store(true, Ordering::SeqCst);
        }
        inner.watching.store(false, Ordering::SeqCst);
        // Stop hearing filesystem events: taken out under the lock, dropped
        // outside it, since dropping joins the watcher's own thread.
        let watcher = lock(&inner.watcher).take();
        drop(watcher);
        inner.hinted.notify_all();
        inner.emit();
        // A lease no call can use any more must not hold admitted saves back.
        inner.gate.end_lease(None);
        std::thread::scope(|scope| {
            scope.spawn(|| inner.push.close(CloseMode::Cancel));
            scope.spawn(|| inner.fetch.close(CloseMode::Cancel));
            let mut admitted = lock(&inner.admitted);
            while *admitted > 0 {
                admitted = inner
                    .settled
                    .wait(admitted)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
            }
            drop(admitted);
            inner.finishing.store(true, Ordering::SeqCst);
            // A fast-forward may request a scan, and a commit pass may too.
            inner.pull.close(CloseMode::Drain);
            inner.commit.close(CloseMode::Drain);
            inner.scan.close(CloseMode::Drain);
        });
        inner.emit();
        *done = true;
    }

    /// What the filesystem watcher's callback does with the paths it hears.
    #[cfg(test)]
    pub(crate) fn announce(&self, paths: &[&str]) {
        self.inner
            .announce(paths.iter().map(|path| path.to_string()));
    }

    #[cfg(test)]
    pub(crate) fn announcements(&self) -> u64 {
        self.inner.announced.load(Ordering::SeqCst)
    }

    #[cfg(test)]
    pub(crate) fn hooks(&self) -> MutexGuard<'_, Hooks> {
        lock(&self.inner.hooks)
    }
}

impl Inner {
    fn admit(&self) -> Result<Admission<'_>, FileError> {
        let mut admitted = lock(&self.admitted);
        if self.closing.load(Ordering::SeqCst) {
            return Err(FileError::Closed);
        }
        *admitted += 1;
        Ok(Admission(self))
    }

    /// Record that the holder of `lease` is waiting on a pass, until dropped.
    fn waiting(&self, lease: Option<u64>) -> Option<Waiting<'_>> {
        let lease = lease?;
        lock(&self.state).waiting_lease = Some(lease);
        self.gate.changed.notify_all();
        Some(Waiting(self, lease))
    }

    fn enter_pass(&self) -> Permit<'_> {
        self.gate.enter_pass(&|| lock(&self.state).waiting_lease)
    }

    /// Admit one explicit Git operation for its whole lifetime.
    fn manual<T>(
        &self,
        operation: &str,
        work: impl FnOnce(&Inner) -> Result<T, String>,
    ) -> Result<T, GitError> {
        let Ok(_admitted) = self.admit() else {
            return Err(GitError::Closed);
        };
        work(self).map_err(|cause| GitError::failed(operation, cause))
    }

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    fn deliver(&self, event: &OwnerEvent) {
        let listeners: Vec<Listener> = lock(&self.listeners)
            .iter()
            .map(|(_, listener)| Arc::clone(listener))
            .collect();
        for listener in listeners {
            listener(event);
        }
    }

    /// Publish the snapshot if it changed. Deliveries are ordered: the lock
    /// that numbers a snapshot is held until its listeners have run.
    fn emit(&self) {
        let activity = |runner_active: bool, pending: bool| Activity {
            active: runner_active,
            pending,
        };
        let activity = Activities {
            scan: activity(self.scan.active(), self.scan.pending()),
            commit: activity(self.commit.active(), self.commit.pending()),
            push: activity(self.push.active(), self.push.pending()),
            fetch: activity(self.fetch.active(), self.fetch.pending()),
            pull: activity(self.pull.active(), self.pull.pending()),
        };
        let mut emitted = lock(&self.emitted);
        let snapshot = {
            let state = lock(&self.state);
            GitSnapshot {
                branch: self.git.branch.clone(),
                remote: self.git.remote.clone(),
                commit_on_edit: self.config.commit_on_edit,
                files: state.files.clone(),
                sync: state.sync.clone(),
                activity,
                last_commit: state.last_commit.clone(),
                last_push: state.last_push.clone(),
                last_fetch: state.last_fetch.clone().map(|attempt| Attempt {
                    result: attempt.result.into(),
                    at: attempt.at,
                }),
                last_pull: state.last_pull.clone().map(|attempt| Attempt {
                    result: attempt.result.into(),
                    at: attempt.at,
                }),
                closed: self.closing.load(Ordering::SeqCst),
            }
        };
        if *emitted.snapshot == snapshot {
            return;
        }
        emitted.sequence += 1;
        emitted.snapshot = Arc::new(snapshot);
        let event = OwnerEvent::Snapshot {
            sequence: emitted.sequence,
            snapshot: (*emitted.snapshot).clone(),
        };
        self.deliver(&event);
    }

    fn files_changed(&self, paths: Vec<String>) {
        let revision = self.revision.fetch_add(1, Ordering::SeqCst) + 1;
        self.deliver(&OwnerEvent::FilesChanged { revision, paths });
    }

    // ------------------------------------------------------------------
    // Publication
    // ------------------------------------------------------------------

    fn stamp(&self, path: &str) -> Option<Stamp> {
        let stats = std::fs::symlink_metadata(self.files.absolute(path)).ok()?;
        stats.file_type().is_file().then(|| Stamp {
            size: stats.len(),
            modified: stats
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|elapsed| elapsed.as_nanos()),
        })
    }

    /// Apply a batch and record what it left, so the external check does not
    /// mistake this owner's writes for someone else's. The caller holds the
    /// file gate.
    fn publish(&self, changes: &[FileChange]) -> Result<(), ApplyError> {
        self.own_in_flight.fetch_add(1, Ordering::SeqCst);
        let result = self.files.apply(changes);
        {
            let mut watch = lock(&self.watch);
            let touched: BTreeSet<String> = changes
                .iter()
                .flat_map(|change| {
                    change
                        .step()
                        .paths()
                        .into_iter()
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
                .collect();
            for path in touched {
                match self.stamp(&path) {
                    Some(stamp) => watch.stamps.insert(path, stamp),
                    None => watch.stamps.remove(&path),
                };
            }
        }
        self.own_done.fetch_add(1, Ordering::SeqCst);
        self.own_in_flight.fetch_sub(1, Ordering::SeqCst);
        result
    }

    /// A known file change: existing observations become stale.
    fn mark_edited(&self) -> bool {
        let mut state = lock(&self.state);
        state.clock += 1;
        state.last_edit = state.clock;
        match &mut state.files {
            Observation::Observed { stale, .. } if !*stale => {
                *stale = true;
                true
            }
            _ => false,
        }
    }

    fn edited(&self, steps: &[FileStep]) {
        self.mark_edited();
        self.emit();
        let paths: BTreeSet<&str> = steps.iter().flat_map(FileStep::paths).collect();
        self.files_changed(paths.into_iter().map(str::to_string).collect());
    }

    /// An operation failed after some of its file changes landed: mark the
    /// observation stale and ask for a fresh scan. This requests no commit.
    fn landed(&self, steps: &[FileStep]) {
        self.edited(steps);
        if !self.finishing.load(Ordering::SeqCst) {
            self.scan.request();
        }
    }

    /// The implicit request after a content save; never awaited by the save.
    fn request_automatic_commit(&self) {
        if !self.config.commit_on_edit || self.finishing.load(Ordering::SeqCst) {
            return;
        }
        lock(&self.state).automatic_queued = true;
        self.commit.request();
    }

    // ------------------------------------------------------------------
    // Observation
    // ------------------------------------------------------------------

    fn tick(&self) -> u64 {
        let mut state = lock(&self.state);
        state.clock += 1;
        state.clock
    }

    /// Record files observed at `captured_at` unless a newer observation exists.
    fn observe_files(&self, captured_at: u64, value: FilesObservation) {
        let mut state = lock(&self.state);
        if matches!(state.files, Observation::Observed { .. })
            && state.files_captured_at > captured_at
        {
            return;
        }
        state.files = Observation::Observed {
            value,
            checked_at: now_ms(),
            stale: state.last_edit > captured_at,
            error: None,
        };
        state.files_captured_at = captured_at;
    }

    fn mark_files_stale(&self) {
        if let Observation::Observed { stale, .. } = &mut lock(&self.state).files {
            *stale = true;
        }
    }

    fn fail_files(&self, cause: String) {
        let mut state = lock(&self.state);
        match &mut state.files {
            Observation::Observed { stale, error, .. } => {
                *stale = true;
                *error = Some(cause);
            }
            unknown => *unknown = Observation::Unknown { error: Some(cause) },
        }
    }

    fn refresh_sync(&self) {
        let observed = (|| {
            let head = self.git.read_branch()?;
            let remote = self.git.read_remote_tracking()?;
            let (ahead, behind) = self.git.ahead_behind(head.as_deref(), remote.as_deref())?;
            Ok::<_, String>(SyncObservation {
                head,
                remote,
                ahead: ahead as u32,
                behind: behind as u32,
            })
        })();
        let mut state = lock(&self.state);
        match observed {
            Ok(value) => {
                state.sync = Observation::Observed {
                    value,
                    checked_at: now_ms(),
                    stale: false,
                    error: None,
                }
            }
            Err(cause) => match &mut state.sync {
                Observation::Observed { stale, error, .. } => {
                    *stale = true;
                    *error = Some(cause);
                }
                unknown => *unknown = Observation::Unknown { error: Some(cause) },
            },
        }
    }

    /// Record a clean observation only if the branch still names `head`;
    /// otherwise invalidate and request a real scan. A failed reread belongs
    /// to the observation, never to the operation that already published.
    fn observe_committed(&self, captured_at: u64, head: Option<&str>) {
        let actual = match self.git.read_branch() {
            Ok(actual) => actual,
            Err(cause) => {
                self.fail_files(cause);
                return;
            }
        };
        if actual.as_deref() == head {
            self.observe_files(
                captured_at,
                FilesObservation {
                    head: head.map(str::to_string),
                    changes: Vec::new(),
                },
            );
            return;
        }
        self.mark_files_stale();
        if !self.finishing.load(Ordering::SeqCst) {
            self.scan.request();
        }
    }

    fn run_scan(&self) -> Result<FilesObservation, GitError> {
        // The snapshot is taken under the file gate; hashing it is not.
        let (captured_at, snapshot) = {
            let _permit = self.enter_pass();
            (self.tick(), self.git.snapshot())
        };
        let result = match snapshot.and_then(|snapshot| self.git.observe(&snapshot)) {
            Ok(observed) => {
                let value = FilesObservation {
                    head: observed.head,
                    changes: observed.changes,
                };
                self.observe_files(captured_at, value.clone());
                self.refresh_sync();
                Ok(value)
            }
            Err(cause) => {
                self.fail_files(cause.clone());
                Err(GitError::failed("status", cause))
            }
        };
        self.emit();
        result
    }

    /// Look for file and ref changes this owner did not make.
    fn poll_external(&self) {
        if self.own_in_flight.load(Ordering::SeqCst) > 0 {
            return;
        }
        let done = self.own_done.load(Ordering::SeqCst);
        let Ok(listing) = self.files.list() else {
            return;
        };
        let stamps: BTreeMap<String, Stamp> = listing
            .files
            .into_iter()
            .filter(|file| is_portable_path(&file.path))
            .filter_map(|file| self.stamp(&file.path).map(|stamp| (file.path, stamp)))
            .collect();
        let refs = self.git.refs_signature();
        let (changed, refs_moved) = {
            let mut watch = lock(&self.watch);
            // A publication overlapped this walk: its stamps may be older than
            // what the walk saw. The next check compares cleanly.
            if self.own_in_flight.load(Ordering::SeqCst) > 0
                || self.own_done.load(Ordering::SeqCst) != done
            {
                return;
            }
            let changed: Vec<String> = if watch.primed {
                let paths: BTreeSet<&String> = watch.stamps.keys().chain(stamps.keys()).collect();
                paths
                    .into_iter()
                    .filter(|path| watch.stamps.get(*path) != stamps.get(*path))
                    .cloned()
                    .collect()
            } else {
                Vec::new()
            };
            let refs_moved = watch.primed && watch.refs != refs;
            watch.primed = true;
            watch.stamps = stamps;
            watch.refs = refs;
            (changed, refs_moved)
        };
        self.report(changed, refs_moved);
    }

    /// Start watching the folder for filesystem events. The callback only
    /// queues what it heard; the watch thread does the looking.
    fn watch_events(&self, owner: Weak<Inner>) -> Result<(), String> {
        use notify::Watcher;
        let root = self.root.clone();
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                let (Ok(event), Some(inner)) = (event, owner.upgrade()) else {
                    return;
                };
                let relative = event.paths.iter().filter_map(|path| {
                    let relative = path.strip_prefix(&root).ok()?.to_str()?;
                    Some(relative.replace(std::path::MAIN_SEPARATOR, "/"))
                });
                inner.announce(relative);
            })
            .map_err(|cause| cause.to_string())?;
        watcher
            .watch(&self.root, notify::RecursiveMode::Recursive)
            .map_err(|cause| cause.to_string())?;
        *lock(&self.watcher) = Some(watcher);
        Ok(())
    }

    /// Queue folder-relative paths a filesystem event named, for the watch
    /// thread to look at. Refs, `HEAD`, and the index say history moved.
    /// Objects, logs, lock files, and this owner's own scratch files and
    /// snapshots say nothing, and must not wake anything.
    fn announce(&self, paths: impl Iterator<Item = String>) {
        let mut heard = Hints::default();
        for relative in paths {
            match relative.strip_prefix(".git/") {
                Some(private) => {
                    heard.git |= !private.ends_with(".lock")
                        && (private == "HEAD"
                            || private == "index"
                            || private == "packed-refs"
                            || private.starts_with("refs/"));
                }
                None if is_portable_path(&relative) => {
                    heard.paths.insert(relative);
                }
                None => {}
            }
        }
        if heard.paths.is_empty() && !heard.git {
            return;
        }
        #[cfg(test)]
        self.announced.fetch_add(1, Ordering::SeqCst);
        let mut hints = lock(&self.hints);
        hints.paths.extend(heard.paths);
        hints.git |= heard.git;
        drop(hints);
        self.hinted.notify_all();
    }

    /// Act on what filesystem events announced. An announced path is looked
    /// at even when its size and time are what they were, because an edit can
    /// restore both. Every announced path is reported, the owner's own writes
    /// included: an event cannot say who wrote, and a missed outside edit
    /// costs more than a listener rereading a file it already has. A report
    /// only marks the observation stale and tells listeners; it requests no
    /// scan and no commit, so the owner's own events cannot feed themselves.
    fn heed(&self, announced: Hints) {
        if self.own_in_flight.load(Ordering::SeqCst) > 0 {
            // A publication is recording what it wrote; look again after it.
            let mut hints = lock(&self.hints);
            hints.paths.extend(announced.paths);
            hints.git |= announced.git;
            drop(hints);
            std::thread::sleep(Duration::from_millis(5));
            return;
        }
        let changed: Vec<String> = {
            let mut watch = lock(&self.watch);
            let mut changed = Vec::new();
            for path in announced.paths {
                let now = self.stamp(&path);
                // A directory, or a file that came and went, is not a change.
                if now.is_none() && !watch.stamps.contains_key(&path) {
                    continue;
                }
                match now {
                    Some(stamp) => watch.stamps.insert(path.clone(), stamp),
                    None => watch.stamps.remove(&path),
                };
                changed.push(path);
            }
            changed
        };
        let refs_moved = announced.git && {
            let refs = self.git.refs_signature();
            let mut watch = lock(&self.watch);
            let moved = watch.primed && watch.refs != refs;
            watch.refs = refs;
            moved
        };
        self.report(changed, refs_moved);
    }

    /// Tell listeners about changes this owner did not make.
    fn report(&self, changed: Vec<String>, refs_moved: bool) {
        if refs_moved {
            // Another Git process moved a ref: the head an observation named
            // may no longer be the branch.
            self.refresh_sync();
            let mut state = lock(&self.state);
            let head = match &state.sync {
                Observation::Observed { value, .. } => value.head.clone(),
                Observation::Unknown { .. } => None,
            };
            if let Observation::Observed { value, stale, .. } = &mut state.files {
                if value.head != head {
                    *stale = true;
                }
            }
        }
        if !changed.is_empty() {
            self.mark_edited();
        }
        if refs_moved || !changed.is_empty() {
            self.emit();
        }
        if !changed.is_empty() {
            self.files_changed(changed);
        }
    }

    // ------------------------------------------------------------------
    // Commit passes
    // ------------------------------------------------------------------

    #[cfg(test)]
    fn hook(&self, pick: fn(&Hooks) -> &Option<Arc<dyn Fn() + Send + Sync>>) {
        // Clone out and release the hooks lock before calling: a hook may
        // wait on work that reads the hooks itself.
        let hook = pick(&lock(&self.hooks)).clone();
        if let Some(hook) = hook {
            hook();
        }
    }

    fn checkpoint(&self) -> Result<CommitOutcome, String> {
        // A fast-forward or staged commit can move the branch and the files
        // between this pass's snapshot and its turn at the Git lock. Bytes
        // snapshotted for one parent are never committed on another: the pass
        // starts over with a fresh snapshot instead.
        for _ in 0..CAPTURE_ATTEMPTS {
            if let Some(outcome) = self.checkpoint_once()? {
                return Ok(outcome);
            }
        }
        Ok(CommitOutcome::Failed {
            error: "the branch kept moving while the folder was being captured".to_string(),
        })
    }

    /// One attempt. `None` means the branch moved after the snapshot was
    /// taken and nothing was published.
    fn checkpoint_once(&self) -> Result<Option<CommitOutcome>, String> {
        if let Some(reason) = self.git.blocked()? {
            return Ok(Some(CommitOutcome::Blocked { reason }));
        }
        let parent = self.git.read_branch()?;
        // The file gate is held only to enumerate and link the folder, and is
        // released before this pass waits for the Git lock, so a save waits
        // for neither hashing nor other Git work.
        let (captured_at, snapshot) = {
            let _permit = self.enter_pass();
            #[cfg(test)]
            self.hook(|hooks| &hooks.during_snapshot);
            (self.tick(), self.git.snapshot()?)
        };
        // From here saves proceed. One that lands now is newer than
        // `captured_at`: this pass still commits what it snapshotted, and the
        // observation it records is stale until that save's own pass.
        #[cfg(test)]
        self.hook(|hooks| &hooks.after_snapshot);

        let _git = lock(&self.git_lock);
        if let Some(reason) = self.git.blocked()? {
            return Ok(Some(CommitOutcome::Blocked { reason }));
        }
        // Nothing is hashed or written for a parent the branch has left.
        if self.git.read_branch()? != parent {
            return Ok(None);
        }
        #[cfg(test)]
        self.hook(|hooks| &hooks.before_hash);
        let captured = match self.git.capture(&snapshot, parent.as_deref())? {
            Capture::Blocked(reason) => return Ok(Some(CommitOutcome::Blocked { reason })),
            Capture::Captured(captured) => captured,
        };
        drop(snapshot);
        #[cfg(test)]
        self.hook(|hooks| &hooks.after_capture);
        let parent_tree = match &parent {
            Some(parent) => self.git.tree_of(parent)?,
            None => crate::git::EMPTY_TREE.to_string(),
        };
        let built = match commit_subject(&captured.changes) {
            Some(message) if captured.tree != parent_tree => {
                let oid = self.git.write_commit(
                    &captured.tree,
                    parent.as_deref(),
                    &message,
                    &self.config.author,
                )?;
                // Another Git process can still move the branch after the
                // check above. That is reported, never retried.
                if let Cas::Lost { actual } = self.git.cas_branch(parent.as_deref(), &oid)? {
                    return Ok(Some(CommitOutcome::BranchMoved {
                        candidate: oid,
                        expected: parent,
                        actual,
                    }));
                }
                Some((oid, message))
            }
            _ => None,
        };
        let head = built
            .as_ref()
            .map(|(oid, _)| oid.clone())
            .or_else(|| parent.clone());
        // A whole-folder commit supersedes staged-only intent: every index
        // entry is reset to the head. The branch has already moved, so a
        // failure here is a warning, not a failed commit.
        let index_warning = head
            .as_deref()
            .and_then(|head| self.git.reconcile_index(head).err());
        self.observe_committed(captured_at, head.as_deref());
        Ok(Some(match built {
            Some((oid, message)) => CommitOutcome::Committed {
                oid,
                parent,
                message,
                changed_paths: captured.changes.len() as u32,
                index_warning,
            },
            None => CommitOutcome::Unchanged {
                head: parent,
                index_warning,
            },
        }))
    }

    fn run_commit(&self) -> CommitPass {
        let automatic = std::mem::take(&mut lock(&self.state).automatic_queued);
        let outcome = self
            .checkpoint()
            .unwrap_or_else(|error| CommitOutcome::Failed { error });
        lock(&self.state).last_commit = Some(Attempt {
            result: outcome.clone(),
            at: now_ms(),
        });
        self.refresh_sync();
        // Only a pass a content save requested pushes afterward; an explicit
        // commit stays local, and commits finishing during close do not push.
        let following_push = (automatic
            && self.config.commit_on_edit
            && !self.closing.load(Ordering::SeqCst)
            && self.git.remote.is_some()
            && matches!(
                outcome,
                CommitOutcome::Committed { .. } | CommitOutcome::Unchanged { .. }
            ))
        .then(|| self.push.request())
        .flatten();
        self.emit();
        CommitPass {
            outcome,
            following_push: following_push.map(|pass| pass as u32),
        }
    }

    fn commit_staged(&self, message: &str) -> Result<(String, Option<String>), GitError> {
        if let Some(reason) = message_problem(message) {
            return Err(GitError::InvalidMessage {
                reason: reason.to_string(),
            });
        }
        let failed = |cause: String| GitError::failed("commit", cause);
        if let Some(blocked) = self.git.blocked().map_err(failed)? {
            return Err(failed(blocked));
        }
        let (result, changed_paths) = {
            let _git = lock(&self.git_lock);
            let staged = self
                .git
                .path_status()
                .map_err(failed)?
                .iter()
                .filter(|path| path.index != " " && path.index != "?")
                .count();
            (
                self.git
                    .commit_index(message, &self.config.author)
                    .map_err(failed)?,
                staged,
            )
        };
        if let IndexCommit::Committed { oid, parent } = &result {
            lock(&self.state).last_commit = Some(Attempt {
                result: CommitOutcome::Committed {
                    oid: oid.clone(),
                    parent: parent.clone(),
                    message: message.to_string(),
                    changed_paths: changed_paths as u32,
                    index_warning: None,
                },
                at: now_ms(),
            });
        }
        self.refresh_sync();
        self.mark_files_stale();
        self.emit();
        match result {
            IndexCommit::Nothing => Err(GitError::NothingToCommit),
            IndexCommit::BranchMoved { actual } => Err(GitError::BranchMoved {
                expected: None,
                actual,
            }),
            IndexCommit::Committed { oid, parent } => Ok((oid, parent)),
        }
    }

    // ------------------------------------------------------------------
    // Remote
    // ------------------------------------------------------------------

    fn run_push(&self, cancel: &AtomicBool) -> PushOutcome {
        if self.git.remote.is_none() {
            return PushOutcome::NoRemote;
        }
        let oid = match self.git.read_branch() {
            Ok(Some(oid)) => oid,
            Ok(None) => return PushOutcome::NothingToPush,
            // No commit was pinned, so there was no attempt to describe.
            Err(reason) => return PushOutcome::Skipped { reason },
        };
        let sequence = {
            let mut state = lock(&self.state);
            state.remote_sequence += 1;
            state.remote_sequence
        };
        let outcome = match self.git.push(&oid, cancel) {
            Ok(()) => PushOutcome::Pushed { oid },
            Err(_) if cancel.load(Ordering::SeqCst) => PushOutcome::Cancelled { oid: Some(oid) },
            Err(error) => PushOutcome::Failed { oid, error },
        };
        // A push that started before a newer fetch or push must not replace its observation.
        if lock(&self.state).remote_sequence == sequence {
            self.refresh_sync();
        }
        lock(&self.state).last_push = Some(Attempt {
            result: outcome.clone(),
            at: now_ms(),
        });
        self.emit();
        outcome
    }

    fn run_fetch(&self, cancel: &AtomicBool) -> Result<FetchOutcome, GitError> {
        if self.git.remote.is_none() {
            return Err(GitError::NoRemote);
        }
        let sequence = {
            let mut state = lock(&self.state);
            state.remote_sequence += 1;
            state.remote_sequence
        };
        let result = self
            .git
            .fetch(cancel)
            .map(|oid| FetchOutcome { oid })
            .map_err(|cause| GitError::failed("fetch", cause));
        if lock(&self.state).remote_sequence == sequence {
            self.refresh_sync();
        }
        lock(&self.state).last_fetch = Some(Attempt {
            result: result.clone(),
            at: now_ms(),
        });
        self.emit();
        result
    }

    fn run_pull(&self) -> Result<PullOutcome, PullError> {
        let result = self
            .pull()
            .unwrap_or_else(|cause| Err(GitError::failed("pull", cause).into()));
        if !matches!(
            result,
            Err(PullError::Git {
                error: GitError::Failed { .. }
            })
        ) {
            self.refresh_sync();
        }
        lock(&self.state).last_pull = Some(Attempt {
            result: result.clone(),
            at: now_ms(),
        });
        self.emit();
        result
    }

    /// The outer error is an unexpected Git failure; the inner one is a
    /// reported outcome.
    fn pull(&self) -> Result<Result<PullOutcome, PullError>, String> {
        if self.git.remote.is_none() {
            return Ok(Err(GitError::NoRemote.into()));
        }
        // The file gate first, then the Git lock: the only order anything
        // takes both in. A commit pass can hold the Git lock for as long as it
        // hashes, so the gate is given back while this waits; saves are never
        // stuck behind a fast-forward that is itself waiting. Both are then
        // held until the files and the branch agree.
        let (_permit, _git) = loop {
            let permit = self.enter_pass();
            match self.git_lock.try_lock() {
                Ok(git) => break (permit, git),
                Err(std::sync::TryLockError::Poisoned(poisoned)) => {
                    break (permit, poisoned.into_inner())
                }
                Err(std::sync::TryLockError::WouldBlock) => {
                    drop(permit);
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
        };
        if let Some(reason) = self.git.blocked()? {
            return Ok(Err(PullError::Blocked { reason }));
        }
        let captured_at = self.tick();
        let Some(fetched) = self.git.read_remote_tracking()? else {
            return Ok(Err(PullError::NoFetchedHead));
        };
        let head = self.git.read_branch()?;
        let snapshot = self.git.snapshot()?;
        if let Some(reason) = self.git.checkpoint_problem(&snapshot, head.as_deref())? {
            return Ok(Err(PullError::Blocked { reason }));
        }
        if head.as_deref() == Some(fetched.as_str()) {
            return Ok(Ok(PullOutcome::UpToDate { head }));
        }
        if let Some(head) = &head {
            if !self.git.is_ancestor(head, &fetched)? {
                if self.git.is_ancestor(&fetched, head)? {
                    return Ok(Ok(PullOutcome::Ahead { head: head.clone() }));
                }
                return Ok(Err(PullError::Diverged {
                    head: head.clone(),
                    fetched,
                }));
            }
        }
        // The entire folder must be clean, including staged changes.
        let (committed, current, raw) = self.git.source_state(&snapshot, head.as_deref())?;
        drop(snapshot);
        let dirty = Git::changes(&committed, &current);
        if !dirty.is_empty() {
            return Ok(Err(PullError::Dirty {
                paths: dirty.into_iter().map(|change| change.path).collect(),
            }));
        }
        if !self.git.index_matches_head()? {
            return Ok(Err(PullError::StagedChanges));
        }

        let incoming = self.git.tree_files(&fetched)?;
        let unrepresentable = |paths: Vec<String>, reason: &str| {
            Ok(Err(PullError::Unrepresentable {
                paths,
                reason: reason.to_string(),
            }))
        };
        let unsupported: Vec<String> = incoming
            .iter()
            .filter(|(_, (mode, _))| mode != "100644")
            .map(|(path, _)| path.clone())
            .collect();
        if !unsupported.is_empty() {
            return unrepresentable(
                unsupported,
                "symbolic links, submodules, and executable files are not plain folder files",
            );
        }
        let invalid: Vec<String> = incoming
            .keys()
            .filter(|path| path_problem(path).is_some())
            .cloned()
            .collect();
        if !invalid.is_empty() {
            return unrepresentable(invalid, "some paths are not valid folder paths");
        }
        // The fast-forward writes each blob's bytes as they are stored. A
        // commit that declares a filter or a conversion for a path means
        // something else by those bytes: under `filter=lfs` the blob is a
        // pointer, not the audio. Every incoming path is asked about, against
        // the fetched commit's own attributes, so a commit that only adds an
        // attribute over a file it does not touch is refused as well.
        if let Some((path, attribute)) = self
            .git
            .normalizing_attribute(Some(&fetched), incoming.keys().map(String::as_str))?
        {
            return unrepresentable(
                vec![path],
                &format!(
                    "the incoming commit declares the Git attribute {attribute}, and this folder does not apply attribute filters or conversion"
                ),
            );
        }
        let mut folded: BTreeMap<String, &String> = BTreeMap::new();
        for path in incoming.keys() {
            if let Some(existing) = folded.insert(collision_key(path), path) {
                return unrepresentable(
                    vec![existing.clone(), path.clone()],
                    "paths collide on case-insensitive filesystems",
                );
            }
        }

        let incoming_oids: BTreeMap<String, String> = incoming
            .iter()
            .map(|(path, (_, oid))| (path.clone(), oid.clone()))
            .collect();
        let changes = Git::changes(&committed, &incoming_oids);
        // Ignored and untracked files are preserved, never overwritten.
        let raw: BTreeSet<&str> = raw.iter().map(String::as_str).collect();
        let colliding: Vec<String> = changes
            .iter()
            .filter(|change| change.kind == ChangeKind::Add)
            .map(|change| &change.path)
            .filter(|path| {
                let below = format!("{path}/");
                raw.contains(path.as_str())
                    || ancestors(path).iter().any(|parent| raw.contains(parent))
                    || raw.iter().any(|existing| existing.starts_with(&below))
            })
            .cloned()
            .collect();
        if !colliding.is_empty() {
            return Ok(Err(PullError::Collision { paths: colliding }));
        }
        #[cfg(test)]
        self.hook(|hooks| &hooks.during_pull);
        let mut removals = Vec::new();
        let mut writes = Vec::new();
        for change in &changes {
            // The clean check above proved the snapshot held exactly the
            // committed bytes, so the committed blob is the baseline each
            // step is conditional on. Reading the working file again here
            // would authorize overwriting whatever another program wrote
            // since the snapshot.
            let expected = match committed.get(&change.path) {
                Some((_, oid)) => {
                    FileExpectation::version(&FileVersion::of(&self.git.read_blob(oid)?))
                }
                None => FileExpectation::Absent,
            };
            if change.kind == ChangeKind::Delete {
                removals.push(FileChange::Remove {
                    path: change.path.clone(),
                    expected,
                });
            } else {
                writes.push(FileChange::Write {
                    path: change.path.clone(),
                    bytes: self.git.read_blob(&incoming_oids[&change.path])?,
                    expected,
                });
            }
        }
        let paths: Vec<String> = changes.iter().map(|change| change.path.clone()).collect();
        removals.extend(writes);
        let steps: Vec<FileStep> = removals.iter().map(FileChange::step).collect();
        match self.publish(&removals) {
            Ok(()) => {}
            Err(ApplyError::Refused { error }) => return Ok(Err(PullError::Refused { error })),
            Err(ApplyError::Unconfirmed { cause, .. }) => return Err(cause),
            Err(ApplyError::Partial { applied, error, .. }) => {
                self.landed(&applied);
                return Ok(Err(PullError::Partial { applied, error }));
            }
        }
        if let Err(error) = self.git.sync_index(&fetched, &paths) {
            self.landed(&steps);
            return Ok(Err(PullError::IndexFailed { error }));
        }
        if let Cas::Lost { actual } = self.git.cas_branch(head.as_deref(), &fetched)? {
            self.landed(&steps);
            return Ok(Err(PullError::BranchMoved {
                actual,
                files_applied: true,
            }));
        }
        self.observe_committed(captured_at, Some(&fetched));
        self.files_changed(paths.clone());
        Ok(Ok(PullOutcome::FastForwarded {
            from: head,
            to: fetched,
            changed_paths: paths,
        }))
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        self.watching.store(false, Ordering::SeqCst);
    }
}
