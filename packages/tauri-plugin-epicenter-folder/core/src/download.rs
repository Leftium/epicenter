//! A first download: a dataset's remote history fetched into staging and
//! published as a new folder, never over one (ADR-0489, "Download").
//!
//! ```text
//! reserve <parent>/<name> with its sibling RootLock      (absent destination)
//!   -> stage in <parent>/.<name>.download-<pid>-<n>       (same filesystem)
//!   -> record the canonical origin
//!   -> fetch main through the relay, under the transfer controls
//!        no main: allowed only when the repository advertises no ref at all
//!   -> write main's files as their exact bytes, set main and the index
//!   -> the caller's binding
//!   -> retire the relay; its transport must confirm the transfer finished
//!   -> publish, unless cancelled: a rename that refuses anything already
//!        at the destination
//!   -> release the reservation
//! ```
//!
//! The native promise is narrow: a repository whose `main` exists, or one
//! with no history at all, which gives an unborn `main`. A repository that has
//! any other ref, a branch or a tag, but no `main` is refused with its refs
//! named, and the staging folder, with `origin` set, is kept. This is not the
//! browser folder's download contract, which can start an unborn `main` beside
//! other refs; nothing here claims to match it.
//!
//! Nothing here opens a [`FolderOwner`](crate::owner::FolderOwner), reads
//! folder configuration, or needs an application schema; the folder opens
//! normally afterward. The tree must be plain folder files under the same
//! rules an incoming update follows: no links, submodules, executables,
//! attribute conversions, invalid paths, or case collisions.
//!
//! An existing destination is refused before anything is fetched. One that
//! appears while the download runs is left exactly as it is: publication is a
//! single rename that fails when anything, even an empty directory, is at the
//! destination (`renamex_np(RENAME_EXCL)` on Apple platforms,
//! `renameat2(RENAME_NOREPLACE)` on Linux). Other platforms, Windows
//! included, refuse before reserving anything until such a publication is
//! proven there.
//!
//! A failure after history arrived keeps the staging directory and names it,
//! so it can be inspected; a failure before that, and a cancellation, remove
//! it. The destination never exists half-made.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use crate::files::{resolve_root, verify_layout, FileChange, Files};
use crate::git::{Cas, Git, Remote};
use crate::lock::{LockError, RootLock};
use crate::owner::plain_problem;
use crate::transport::{with_report, Relay};

#[cfg(test)]
thread_local! {
    /// Runs just before publication, on the downloading thread, with the
    /// destination: another program's last move.
    pub(crate) static BEFORE_PUBLISH: std::cell::RefCell<Option<Box<dyn Fn(&Path)>>> =
        std::cell::RefCell::new(None);
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DownloadError {
    /// Something is already at the destination. Nothing was fetched.
    Exists { path: PathBuf },
    /// Another process holds the destination's lock. Nothing was fetched.
    Busy { path: PathBuf },
    /// This platform cannot publish without risking what is already there.
    /// Nothing was reserved or fetched.
    Unsupported { message: String },
    /// Cancelled before publication. Nothing was published or kept.
    Cancelled,
    /// The destination was not created. `staging` names fetched history kept
    /// for inspection, when there is any.
    Failed {
        message: String,
        staging: Option<PathBuf>,
    },
    /// Cancelled as the folder was put in place: it is at `root`, complete
    /// and confirmed, but the caller asked to stop, so it is not reported as
    /// a finished download and nothing should open it on its own.
    Interrupted { root: PathBuf },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Downloaded {
    /// The published folder.
    pub root: PathBuf,
    /// Its `main`, or `None` when the repository was empty.
    pub head: Option<String>,
}

static STAGING_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// The staging directory, removed when dropped unless kept.
struct Staging {
    path: PathBuf,
    keep: bool,
}

impl Drop for Staging {
    fn drop(&mut self) {
        if !self.keep {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

/// Why filling the staging directory stopped.
enum Stop {
    Cancelled,
    /// `keep` when history arrived and is worth inspecting.
    Failed {
        message: String,
        keep: bool,
    },
}

impl Stop {
    fn early(message: impl Into<String>) -> Self {
        Self::Failed {
            message: message.into(),
            keep: false,
        }
    }

    fn kept(message: impl Into<String>) -> Self {
        Self::Failed {
            message: message.into(),
            keep: true,
        }
    }
}

/// Download `remote`'s `main` into a new folder `<parent>/<name>`.
///
/// `parent` must be canonical. `start` opens the one upload-pack relay the
/// download uses; it is called only once the destination is reserved and
/// absent. The relay is retired as soon as the download stops, and otherwise
/// before publication: a retirement that reports anything (the transport was
/// already gone, or saw a refusal) publishes nothing and keeps staging.
/// `bind` writes the caller's record of what was downloaded into the staged
/// folder, after `origin` and before publication. `cancel` is checked again
/// at publication and just after it.
pub fn download(
    parent: &Path,
    name: &str,
    remote: &Remote,
    start: impl FnOnce() -> Result<Relay, String>,
    cancel: &AtomicBool,
    bind: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<Downloaded, DownloadError> {
    let failed = |message: String| DownloadError::Failed {
        message,
        staging: None,
    };
    if name.is_empty() || name.starts_with('.') || name.contains(['/', '\\']) {
        return Err(failed(format!("{name:?} cannot name a folder")));
    }
    match resolve_root(parent) {
        Ok(resolved) if resolved == parent => {}
        Ok(_) => {
            return Err(failed(format!(
                "{} is not a canonical directory",
                parent.display()
            )))
        }
        Err(message) => return Err(failed(message)),
    }
    publish::supported().map_err(|message| DownloadError::Unsupported { message })?;
    let destination = parent.join(name);
    // Held until publication is settled. The lock does not need the
    // destination to exist; the folder's owner later takes the same file.
    let _reservation = RootLock::acquire(&destination).map_err(|error| match error {
        LockError::Busy { root } => DownloadError::Busy { path: root },
        LockError::Failed { message } => failed(message),
    })?;
    if present(&destination).map_err(failed)? {
        return Err(DownloadError::Exists { path: destination });
    }
    if cancel.load(Ordering::SeqCst) {
        return Err(DownloadError::Cancelled);
    }
    let path = parent.join(format!(
        ".{name}.download-{}-{}",
        std::process::id(),
        STAGING_SEQUENCE.fetch_add(1, Ordering::SeqCst)
    ));
    fs::create_dir(&path).map_err(|cause| failed(format!("create {}: {cause}", path.display())))?;
    let mut staging = Staging { path, keep: false };

    let (relay, head) = match fill(&staging.path, remote, start, cancel, bind) {
        Ok(filled) => filled,
        Err(Stop::Cancelled) => return Err(DownloadError::Cancelled),
        Err(Stop::Failed { message, keep }) => {
            staging.keep = keep;
            return Err(DownloadError::Failed {
                message,
                staging: keep.then(|| staging.path.clone()),
            });
        }
    };
    if cancel.load(Ordering::SeqCst) {
        relay.retire();
        return Err(DownloadError::Cancelled);
    }
    // Finish the transfer, and have its own transport confirm it, before
    // anything is published. A relay its account already retired, or a host
    // that cannot answer for it, is not a finished download: the history
    // stays in staging for a person to inspect, and the destination stays
    // absent.
    if let Some(report) = relay.retire() {
        staging.keep = true;
        return Err(DownloadError::Failed {
            message: format!(
                "The download's transfer could not be confirmed as finished, so it was not put in place. {report}"
            ),
            staging: Some(staging.path.clone()),
        });
    }
    // The publication boundary: a cancel that arrived while the transfer was
    // being confirmed still publishes nothing.
    if cancel.load(Ordering::SeqCst) {
        return Err(DownloadError::Cancelled);
    }

    #[cfg(test)]
    BEFORE_PUBLISH.with(|hook| {
        if let Some(hook) = hook.borrow().as_ref() {
            hook(&destination);
        }
    });
    // From here the staged folder is either the destination or kept.
    staging.keep = true;
    if let Err(cause) = publish::no_clobber(&staging.path, &destination) {
        let message = if cause.kind() == ErrorKind::AlreadyExists {
            format!(
                "Something appeared at {} while the download ran. It was left exactly as it is, and the download was kept at {}",
                destination.display(),
                staging.path.display()
            )
        } else {
            format!(
                "The download could not be put in place at {}: {cause}. It was kept at {}",
                destination.display(),
                staging.path.display()
            )
        };
        return Err(DownloadError::Failed {
            message,
            staging: Some(staging.path.clone()),
        });
    }
    // A cancel that landed with the rename cannot unpublish it, and nothing
    // here tries: the folder stays where it landed, but it is not reported
    // as a finished download.
    if cancel.load(Ordering::SeqCst) {
        return Err(DownloadError::Interrupted { root: destination });
    }
    Ok(Downloaded {
        root: destination,
        head,
    })
}

/// Why a repository without `branch` cannot be downloaded, given every ref it
/// advertises; `None` when it advertises none and so is empty. A download
/// never chooses another branch or a tag in place of the one asked for.
fn missing_branch(branch: &str, refs: &[String]) -> Option<String> {
    if refs.is_empty() {
        return None;
    }
    const SHOWN: usize = 5;
    let mut shown = refs
        .iter()
        .take(SHOWN)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    if refs.len() > SHOWN {
        shown.push_str(&format!(", and {} more", refs.len() - SHOWN));
    }
    Some(format!(
        "The repository has no {branch} branch, but it is not empty: it has {shown}. Epicenter downloads {branch}, or a repository with no history at all, and never picks another branch or tag. Create {branch} in the repository, then download again"
    ))
}

/// Whether anything at all is at `path`, a link or a file included.
fn present(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(cause) if cause.kind() == ErrorKind::NotFound => Ok(false),
        Err(cause) => Err(format!("inspect {}: {cause}", path.display())),
    }
}

/// Fetch into `staging` and make it the folder `main` describes. The relay is
/// returned open; every early return retires it by dropping it.
fn fill(
    staging: &Path,
    remote: &Remote,
    start: impl FnOnce() -> Result<Relay, String>,
    cancel: &AtomicBool,
    bind: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<(Relay, Option<String>), Stop> {
    let git = Git::open(staging, &remote.branch, Some(remote.clone())).map_err(Stop::early)?;
    verify_layout(staging).map_err(Stop::early)?;
    // Before any transfer, so a staging folder kept for inspection already
    // names its canonical repository.
    git.configure_origin(remote).map_err(Stop::early)?;
    let relay = start().map_err(Stop::early)?;
    let cancelled = || cancel.load(Ordering::SeqCst);

    let head = match git.fetch(cancel, Some(&relay)) {
        _ if cancelled() => return Err(Stop::Cancelled),
        Err(failure) => return Err(Stop::early(with_report(failure, relay.retire()))),
        Ok(Some(oid)) => Some(oid),
        // No `main`: allowed only when the repository advertises no ref at
        // all. A tag or any other ref is history this download would drop.
        Ok(None) => match git.remote_refs(&relay, cancel) {
            _ if cancelled() => return Err(Stop::Cancelled),
            Err(failure) => return Err(Stop::early(with_report(failure, relay.retire()))),
            Ok(refs) => match missing_branch(&remote.branch, &refs) {
                None => None,
                Some(message) => return Err(Stop::kept(message)),
            },
        },
    };

    if let Some(oid) = &head {
        let kept = |cause: String| Stop::kept(cause);
        let files = git.tree_files(oid).map_err(kept)?;
        if let Some((paths, reason)) = plain_problem(&git, oid, &files).map_err(kept)? {
            return Err(Stop::kept(format!(
                "The repository's {} cannot be a folder here: {reason} ({})",
                remote.branch,
                paths.join(", ")
            )));
        }
        // Each blob's exact bytes, created where nothing is: no checkout, so
        // no filter, conversion, or hook runs.
        let writer = Files::new(staging);
        for (path, (_, blob)) in &files {
            if cancelled() {
                return Err(Stop::Cancelled);
            }
            let bytes = git.read_blob(blob).map_err(kept)?;
            writer
                .apply(&[FileChange::Create {
                    path: path.clone(),
                    bytes,
                }])
                .map_err(|error| Stop::kept(format!("write {path}: {error:?}")))?;
        }
        match git.cas_branch(None, oid).map_err(kept)? {
            Cas::Moved => {}
            Cas::Lost { actual } => {
                return Err(Stop::kept(format!(
                    "{} moved to {actual:?} while the download was being set up",
                    remote.branch
                )))
            }
        }
        git.reconcile_index(oid).map_err(kept)?;
    }
    let keep = head.is_some();
    let stop = |message: String| Stop::Failed { message, keep };
    bind(staging).map_err(stop)?;
    verify_layout(staging).map_err(stop)?;
    if cancelled() {
        return Err(Stop::Cancelled);
    }
    Ok((relay, head))
}

/// Publication that never replaces anything at the destination.
mod publish {
    use std::io;
    use std::path::Path;

    #[cfg(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "linux",
        target_os = "android"
    ))]
    pub(super) fn supported() -> Result<(), String> {
        Ok(())
    }

    #[cfg(not(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "linux",
        target_os = "android"
    )))]
    pub(super) fn supported() -> Result<(), String> {
        Err(format!(
            "Downloading a folder is not available on {} yet: Epicenter has no way there to put a folder in place that refuses one already there. Nothing was downloaded.",
            std::env::consts::OS
        ))
    }

    /// Rename `from` to `to`, failing with `AlreadyExists` when anything,
    /// even an empty directory, is at `to`.
    #[cfg(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "linux",
        target_os = "android"
    ))]
    pub(super) fn no_clobber(from: &Path, to: &Path) -> io::Result<()> {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;

        let from = CString::new(from.as_os_str().as_bytes())?;
        let to = CString::new(to.as_os_str().as_bytes())?;
        if rename_exclusive(&from, &to) == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    fn rename_exclusive(from: &std::ffi::CStr, to: &std::ffi::CStr) -> libc::c_int {
        // SAFETY: both pointers are NUL-terminated paths that outlive the call.
        unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) }
    }

    #[cfg(any(target_os = "linux", target_os = "android"))]
    fn rename_exclusive(from: &std::ffi::CStr, to: &std::ffi::CStr) -> libc::c_int {
        /// `linux/fs.h`; the kernel ABI value, defined here so an older C
        /// library's headers do not matter.
        const RENAME_NOREPLACE: libc::c_uint = 1 << 0;
        // SAFETY: both pointers are NUL-terminated paths that outlive the
        // call, and the arguments match renameat2(2).
        unsafe {
            libc::syscall(
                libc::SYS_renameat2,
                libc::AT_FDCWD,
                from.as_ptr(),
                libc::AT_FDCWD,
                to.as_ptr(),
                RENAME_NOREPLACE,
            ) as libc::c_int
        }
    }

    #[cfg(not(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "linux",
        target_os = "android"
    )))]
    pub(super) fn no_clobber(_from: &Path, _to: &Path) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "publication that refuses an existing directory is not available here",
        ))
    }
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod tests {
    //! Transfers here reach a loopback `git http-backend` through the
    //! production relay transport: HTTP only, every control on. Where this
    //! environment refuses a listener, those tests say so on stderr and stop;
    //! `EPICENTER_REQUIRE_LOOPBACK=1` makes that a failure. Everything that
    //! needs no transfer, or only a refused one, runs everywhere.

    use super::*;
    use std::sync::{Arc, Mutex};

    use crate::files::has_repository;
    use crate::testing::{git, GitHttp, TempDir};

    const CANONICAL: &str = "https://github.com/alice/zhongwen.git";
    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn canonical() -> Remote {
        Remote {
            url: CANONICAL.to_string(),
            branch: "main".to_string(),
        }
    }

    /// A served bare repository and the relay URL that reaches it.
    struct Served {
        http: GitHttp,
        bare: PathBuf,
        url: String,
    }

    /// An empty bare repository at a relay-shaped path, served over loopback
    /// HTTP, or `None` where no listener can be bound.
    fn served(test: &str, temp: &TempDir) -> Option<Served> {
        let project = temp.folder("served");
        let path = format!("{TOKEN}/repo.git");
        let bare = project.join(&path);
        fs::create_dir_all(&bare).unwrap();
        git(
            &bare,
            &["init", "--quiet", "--bare", "--initial-branch=main"],
        );
        let http = GitHttp::start(test, &project)?;
        let url = http.url(&path);
        Some(Served { http, bare, url })
    }

    /// Commit `files` in the author repository and push it to `bare` as `to`,
    /// a full ref name such as `refs/heads/main` or `refs/tags/retained`.
    fn seed(temp: &TempDir, bare: &Path, files: &[(&str, &[u8])], to: &str) {
        let work = temp.folder("author");
        if !work.join(".git").exists() {
            git(&work, &["init", "--quiet", "--initial-branch=main"]);
        }
        for (path, bytes) in files {
            let target = work.join(path);
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::write(target, bytes).unwrap();
        }
        git(&work, &["add", "--all"]);
        git(&work, &["commit", "--quiet", "--allow-empty", "-m", "seed"]);
        let refspec = format!("HEAD:{to}");
        git(
            &work,
            &["push", "--quiet", bare.to_str().unwrap(), &refspec],
        );
    }

    /// What happened to one test relay, in order.
    #[derive(Clone, Default)]
    struct Journal(Arc<Mutex<Vec<String>>>);

    impl Journal {
        fn note(&self, entry: impl Into<String>) {
            self.0.lock().unwrap().push(entry.into());
        }

        fn entries(&self) -> Vec<String> {
            self.0.lock().unwrap().clone()
        }
    }

    /// A relay to `url`. Retiring notes whether the destination was
    /// published by then and reports `report`.
    fn relay_to(
        url: &str,
        journal: &Journal,
        destination: PathBuf,
        report: Option<&str>,
    ) -> impl FnOnce() -> Result<Relay, String> {
        let url = url.to_string();
        let journal = journal.clone();
        let report = report.map(str::to_string);
        move || {
            journal.note("started");
            let retired = journal.clone();
            Ok(Relay::new(url, move || {
                // Published means the download's own `.git` is there, not
                // merely that something is at the path.
                retired.note(if destination.join(".git").exists() {
                    "retired after publication"
                } else {
                    "retired before publication"
                });
                report
            }))
        }
    }

    /// An empty download has written no file, so `.git/epicenter` may not exist yet.
    fn binding(staging: &Path) -> Result<(), String> {
        fs::create_dir_all(staging.join(".git/epicenter")).map_err(|cause| cause.to_string())?;
        fs::write(
            staging.join(".git/epicenter/binding.json"),
            b"{\"bound\":true}",
        )
        .map_err(|cause| cause.to_string())
    }

    /// Every name in `parent` except the destination's lock file.
    fn siblings(parent: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(parent)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| !name.ends_with(".epicenter-lock"))
            .collect();
        names.sort();
        names
    }

    #[test]
    fn downloads_main_as_exact_files_with_origin_binding_and_a_clean_index() {
        let temp = TempDir::new("download");
        let Some(served) = served("downloads_main_as_exact_files", &temp) else {
            return;
        };
        let readme: &[u8] = "# 你好\r\nkeep CRLF\r\n".as_bytes();
        seed(
            &temp,
            &served.bare,
            &[
                ("decks/hsk1.md", readme),
                ("kv.json", b"{\"a\":1}"),
                ("audio/clip.bin", &[0, 159, 146, 150, 255]),
            ],
            "refs/heads/main",
        );
        let parent = temp.folder("accounts");
        let destination = parent.join("com.bradenwong.zhongwen");
        let journal = Journal::default();

        let downloaded = download(
            &parent,
            "com.bradenwong.zhongwen",
            &canonical(),
            relay_to(&served.url, &journal, destination.clone(), None),
            &AtomicBool::new(false),
            binding,
        )
        .unwrap();

        let oid = git(&served.bare, &["rev-parse", "main"]);
        assert_eq!(
            downloaded,
            Downloaded {
                root: destination.clone(),
                head: Some(oid.clone())
            }
        );
        assert_eq!(fs::read(destination.join("decks/hsk1.md")).unwrap(), readme);
        assert_eq!(
            fs::read(destination.join("audio/clip.bin")).unwrap(),
            [0, 159, 146, 150, 255]
        );
        assert_eq!(git(&destination, &["rev-parse", "main"]), oid);
        assert_eq!(
            git(&destination, &["symbolic-ref", "HEAD"]),
            "refs/heads/main"
        );
        assert_eq!(
            git(&destination, &["rev-parse", "refs/remotes/origin/main"]),
            oid
        );
        // The canonical destination, never the relay.
        assert_eq!(
            git(&destination, &["config", "remote.origin.url"]),
            CANONICAL
        );
        assert_eq!(
            git(&destination, &["config", "remote.origin.fetch"]),
            "+refs/heads/main:refs/remotes/origin/main"
        );
        assert_eq!(git(&destination, &["status", "--porcelain"]), "");
        assert!(!git(&destination, &["config", "--list"]).contains(TOKEN));
        assert_eq!(
            fs::read_to_string(destination.join(".git/epicenter/binding.json")).unwrap(),
            "{\"bound\":true}"
        );
        assert_eq!(siblings(&parent), vec!["com.bradenwong.zhongwen"]);
        // The transfer was confirmed finished before anything was published.
        assert_eq!(
            journal.entries(),
            vec!["started", "retired before publication"]
        );
        // Only the upload-pack service of the relay path was ever asked for.
        let requests = served.http.requests();
        assert!(!requests.is_empty());
        for request in &requests {
            assert!(
                request.contains(&format!("/{TOKEN}/repo.git/"))
                    && request.contains("git-upload-pack")
                    && !request.contains("git-receive-pack"),
                "{request}"
            );
        }
        // The reservation was released: the folder's owner can take the lock.
        RootLock::acquire(&destination).unwrap();
    }

    #[test]
    fn an_empty_repository_downloads_an_unborn_main_without_a_commit() {
        let temp = TempDir::new("download-empty");
        let Some(served) = served("an_empty_repository_downloads", &temp) else {
            return;
        };
        let parent = temp.folder("accounts");
        let destination = parent.join("so.epicenter.notes");
        let journal = Journal::default();

        let downloaded = download(
            &parent,
            "so.epicenter.notes",
            &canonical(),
            relay_to(&served.url, &journal, destination.clone(), None),
            &AtomicBool::new(false),
            binding,
        )
        .unwrap();

        assert_eq!(downloaded.head, None);
        assert_eq!(
            git(&destination, &["symbolic-ref", "HEAD"]),
            "refs/heads/main"
        );
        assert_eq!(git(&destination, &["rev-list", "--all", "--count"]), "0");
        assert_eq!(
            git(&destination, &["config", "remote.origin.url"]),
            CANONICAL
        );
        assert!(destination.join(".git/epicenter/binding.json").is_file());
        // An unborn main is a repository an account folder may open.
        assert!(has_repository(&destination).unwrap());
        assert_eq!(
            journal.entries(),
            vec!["started", "retired before publication"]
        );
    }

    #[test]
    fn a_repository_with_refs_but_no_main_is_refused_and_its_staging_kept() {
        for (label, to) in [
            ("tag only", "refs/tags/retained"),
            ("another branch", "refs/heads/trunk"),
        ] {
            let temp = TempDir::new("download-no-main");
            let Some(served) = served("a_repository_with_refs_but_no_main", &temp) else {
                return;
            };
            seed(&temp, &served.bare, &[("a.md", b"history")], to);
            let parent = temp.folder("accounts");
            let destination = parent.join("so.epicenter.notes");
            let journal = Journal::default();

            let error = download(
                &parent,
                "so.epicenter.notes",
                &canonical(),
                relay_to(&served.url, &journal, destination.clone(), None),
                &AtomicBool::new(false),
                binding,
            )
            .unwrap_err();

            let DownloadError::Failed {
                message,
                staging: Some(staging),
            } = error
            else {
                panic!("{label}: a kept refusal, not {error:?}");
            };
            assert!(
                message.contains("no main branch, but it is not empty"),
                "{label}: {message}"
            );
            assert!(message.contains(to), "{label}: {message}");
            assert!(!message.contains(TOKEN), "{label}: {message}");
            assert!(!destination.exists(), "{label}");
            // Kept, naming its canonical repository, for the person to inspect.
            assert_eq!(
                git(&staging, &["config", "remote.origin.url"]),
                CANONICAL,
                "{label}"
            );
            assert_eq!(
                journal.entries(),
                vec!["started", "retired before publication"],
                "{label}"
            );
        }
    }

    #[test]
    fn only_a_repository_without_any_ref_counts_as_empty() {
        assert_eq!(missing_branch("main", &[]), None);
        for refs in [
            vec!["refs/tags/retained".to_string()],
            vec!["refs/heads/trunk".to_string()],
            vec!["refs/notes/commits".to_string()],
        ] {
            let message = missing_branch("main", &refs).unwrap();
            assert!(message.contains(&refs[0]), "{message}");
            assert!(message.contains("never picks another branch or tag"));
        }
        let many: Vec<String> = (0..8).map(|n| format!("refs/tags/v{n}")).collect();
        let message = missing_branch("main", &many).unwrap();
        assert!(message.contains("refs/tags/v4, and 3 more"), "{message}");
    }

    #[test]
    fn an_existing_destination_is_refused_before_anything_is_fetched() {
        let temp = TempDir::new("download-exists");
        let parent = temp.folder("accounts");
        let outside = temp.folder("outside");
        for kind in ["empty directory", "folder", "file", "link"] {
            let destination = parent.join("so.epicenter.notes");
            let _ = fs::remove_dir_all(&destination);
            let _ = fs::remove_file(&destination);
            match kind {
                "empty directory" => fs::create_dir(&destination).unwrap(),
                "folder" => {
                    fs::create_dir(&destination).unwrap();
                    fs::write(destination.join("mine.md"), "mine").unwrap();
                }
                "file" => fs::write(&destination, "file").unwrap(),
                _ => std::os::unix::fs::symlink(&outside, &destination).unwrap(),
            }
            let error = download(
                &parent,
                "so.epicenter.notes",
                &canonical(),
                || panic!("no transfer starts for an existing destination"),
                &AtomicBool::new(false),
                |_| panic!("nothing is bound"),
            )
            .unwrap_err();
            assert_eq!(
                error,
                DownloadError::Exists {
                    path: destination.clone()
                },
                "{kind}"
            );
            assert_eq!(siblings(&parent), vec!["so.epicenter.notes"], "{kind}");
        }
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
    }

    #[test]
    fn a_held_reservation_is_busy_and_starts_nothing() {
        let temp = TempDir::new("download-busy");
        let parent = temp.folder("accounts");
        let destination = parent.join("so.epicenter.notes");
        let _held = RootLock::acquire(&destination).unwrap();
        let error = download(
            &parent,
            "so.epicenter.notes",
            &canonical(),
            || panic!("no transfer starts while another process holds the folder"),
            &AtomicBool::new(false),
            |_| panic!("nothing is bound"),
        )
        .unwrap_err();
        assert_eq!(
            error,
            DownloadError::Busy {
                path: destination.clone()
            }
        );
        assert!(!destination.exists());
    }

    /// Commit `extra` into the author repository through the index alone, so
    /// paths a case-insensitive disk would fold stay distinct, and push it.
    fn commit_index_only(temp: &TempDir, bare: &Path, extra: &[(&str, &str)]) {
        let work = temp.path().join("author");
        for (path, text) in extra {
            let blob_file = temp.path().join("blob");
            fs::write(&blob_file, text).unwrap();
            let blob = git(&work, &["hash-object", "-w", blob_file.to_str().unwrap()]);
            let info = format!("100644,{blob},{path}");
            git(&work, &["update-index", "--add", "--cacheinfo", &info]);
        }
        git(&work, &["commit", "--quiet", "-m", "index only"]);
        git(
            &work,
            &[
                "push",
                "--quiet",
                bare.to_str().unwrap(),
                "HEAD:refs/heads/main",
            ],
        );
    }

    #[test]
    fn history_that_is_not_plain_files_is_refused_and_kept_for_inspection() {
        for (label, extra) in [
            (
                "attribute",
                vec![(".gitattributes", "*.md text eol=crlf\n")],
            ),
            ("collision", vec![("Notes.md", "a"), ("notes.md", "b")]),
        ] {
            let temp = TempDir::new("download-plain");
            let Some(served) = served("history_that_is_not_plain_files", &temp) else {
                return;
            };
            seed(&temp, &served.bare, &[("a.md", b"a\n")], "refs/heads/main");
            commit_index_only(&temp, &served.bare, &extra);
            let parent = temp.folder("accounts");
            let destination = parent.join("so.epicenter.notes");
            let journal = Journal::default();
            let error = download(
                &parent,
                "so.epicenter.notes",
                &canonical(),
                relay_to(&served.url, &journal, destination.clone(), None),
                &AtomicBool::new(false),
                binding,
            )
            .unwrap_err();
            let DownloadError::Failed {
                message,
                staging: Some(staging),
            } = error
            else {
                panic!("{label}: a refusal that keeps the fetched history, not {error:?}");
            };
            assert!(
                message.contains("cannot be a folder here"),
                "{label}: {message}"
            );
            assert!(!destination.exists(), "{label}");
            // The fetched history is there to inspect, unpublished.
            let oid = git(&served.bare, &["rev-parse", "main"]);
            assert_eq!(
                git(&staging, &["rev-parse", "refs/remotes/origin/main"]),
                oid
            );
            assert!(staging
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(".so.epicenter.notes.download-"));
            assert_eq!(
                journal.entries(),
                vec!["started", "retired before publication"]
            );
        }
    }

    #[test]
    fn an_executable_or_link_in_history_is_refused() {
        let temp = TempDir::new("download-modes");
        let Some(served) = served("an_executable_or_link_in_history", &temp) else {
            return;
        };
        seed(
            &temp,
            &served.bare,
            &[("run.sh", b"#!/bin/sh\n")],
            "refs/heads/main",
        );
        let work = temp.path().join("author");
        git(&work, &["update-index", "--chmod=+x", "run.sh"]);
        std::os::unix::fs::symlink("run.sh", work.join("link")).unwrap();
        git(&work, &["add", "link"]);
        git(&work, &["commit", "--quiet", "-m", "modes"]);
        git(
            &work,
            &[
                "push",
                "--quiet",
                served.bare.to_str().unwrap(),
                "HEAD:refs/heads/main",
            ],
        );
        let parent = temp.folder("accounts");
        let destination = parent.join("so.epicenter.notes");
        let error = download(
            &parent,
            "so.epicenter.notes",
            &canonical(),
            relay_to(&served.url, &Journal::default(), destination.clone(), None),
            &AtomicBool::new(false),
            binding,
        )
        .unwrap_err();
        let DownloadError::Failed {
            message,
            staging: Some(_),
        } = error
        else {
            panic!("a kept refusal, not {error:?}");
        };
        assert!(
            message.contains("link") && message.contains("run.sh"),
            "{message}"
        );
        assert!(!destination.exists());
    }

    #[test]
    fn a_destination_that_appears_during_the_download_is_never_overwritten() {
        // An empty directory is what a plain rename would silently replace.
        for theirs in [None, Some("theirs.md")] {
            let temp = TempDir::new("download-race");
            let Some(served) = served("a_destination_that_appears", &temp) else {
                return;
            };
            seed(
                &temp,
                &served.bare,
                &[("a.md", b"downloaded")],
                "refs/heads/main",
            );
            let parent = temp.folder("accounts");
            let destination = parent.join("so.epicenter.notes");
            let journal = Journal::default();
            let created = theirs;
            BEFORE_PUBLISH.with(|hook| {
                *hook.borrow_mut() = Some(Box::new(move |destination: &Path| {
                    fs::create_dir(destination).unwrap();
                    if let Some(name) = created {
                        fs::write(destination.join(name), "theirs").unwrap();
                    }
                }))
            });
            let error = download(
                &parent,
                "so.epicenter.notes",
                &canonical(),
                relay_to(&served.url, &journal, destination.clone(), None),
                &AtomicBool::new(false),
                binding,
            )
            .unwrap_err();
            BEFORE_PUBLISH.with(|hook| hook.borrow_mut().take());

            let DownloadError::Failed {
                message,
                staging: Some(staging),
            } = error
            else {
                panic!("a kept refusal, not {error:?}");
            };
            assert!(message.contains("left exactly as it is"), "{message}");
            let found: Vec<String> = fs::read_dir(&destination)
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            assert_eq!(
                found,
                theirs.into_iter().map(str::to_string).collect::<Vec<_>>()
            );
            if let Some(name) = theirs {
                assert_eq!(
                    fs::read_to_string(destination.join(name)).unwrap(),
                    "theirs"
                );
            }
            // The whole download is kept beside it.
            assert_eq!(
                fs::read_to_string(staging.join("a.md")).unwrap(),
                "downloaded"
            );
            assert!(staging.join(".git/epicenter/binding.json").is_file());
            assert_eq!(
                journal.entries(),
                vec!["started", "retired before publication"]
            );
        }
    }

    #[test]
    fn a_download_cancelled_after_its_history_arrived_publishes_and_keeps_nothing() {
        let temp = TempDir::new("download-cancel");
        let Some(served) = served("a_download_cancelled_after_its_history", &temp) else {
            return;
        };
        seed(&temp, &served.bare, &[("a.md", b"a")], "refs/heads/main");
        let parent = temp.folder("accounts");
        let destination = parent.join("so.epicenter.notes");
        let journal = Journal::default();
        let cancel = AtomicBool::new(false);
        // The cancel arrives after the history did, just before publication.
        let error = download(
            &parent,
            "so.epicenter.notes",
            &canonical(),
            relay_to(&served.url, &journal, destination.clone(), None),
            &cancel,
            |staging| {
                cancel.store(true, Ordering::SeqCst);
                binding(staging)
            },
        )
        .unwrap_err();
        assert_eq!(error, DownloadError::Cancelled);
        assert!(!destination.exists());
        assert_eq!(siblings(&parent), Vec::<String>::new());
        assert_eq!(
            journal.entries(),
            vec!["started", "retired before publication"]
        );
    }

    /// Git finished, but the transport cannot confirm the transfer: its
    /// account was disposed (the relay was already gone) or it saw a
    /// refusal. Nothing is published, and the fetched history is kept.
    #[test]
    fn a_transfer_its_transport_cannot_confirm_is_kept_and_never_published() {
        let temp = TempDir::new("download-unconfirmed");
        let Some(served) = served("a_transfer_its_transport_cannot_confirm", &temp) else {
            return;
        };
        seed(
            &temp,
            &served.bare,
            &[("a.md", b"old account bytes")],
            "refs/heads/main",
        );
        let parent = temp.folder("accounts");
        let destination = parent.join("so.epicenter.notes");
        let journal = Journal::default();
        let error = download(
            &parent,
            "so.epicenter.notes",
            &canonical(),
            relay_to(
                &served.url,
                &journal,
                destination.clone(),
                Some("Its connection had already ended before Epicenter could confirm it."),
            ),
            &AtomicBool::new(false),
            binding,
        )
        .unwrap_err();
        let DownloadError::Failed {
            message,
            staging: Some(staging),
        } = error
        else {
            panic!("a kept, unpublished failure, not {error:?}");
        };
        assert!(message.contains("could not be confirmed"), "{message}");
        assert!(message.contains("already ended"), "{message}");
        assert!(!destination.exists());
        // The fetched bytes stay, repairable, beside the absent destination.
        assert_eq!(
            fs::read_to_string(staging.join("a.md")).unwrap(),
            "old account bytes"
        );
        assert_eq!(git(&staging, &["config", "remote.origin.url"]), CANONICAL);
        assert_eq!(
            journal.entries(),
            vec!["started", "retired before publication"]
        );
    }

    /// A cancel that arrives while the transfer is being confirmed is still
    /// seen at the publication boundary: nothing is published.
    #[test]
    fn a_cancel_during_confirmation_publishes_nothing() {
        let temp = TempDir::new("download-cancel-confirming");
        let Some(served) = served("a_cancel_during_confirmation", &temp) else {
            return;
        };
        seed(&temp, &served.bare, &[("a.md", b"a")], "refs/heads/main");
        let parent = temp.folder("accounts");
        let destination = parent.join("so.epicenter.notes");
        let cancel = Arc::new(AtomicBool::new(false));
        let cancelling = Arc::clone(&cancel);
        let url = served.url.clone();
        let error = download(
            &parent,
            "so.epicenter.notes",
            &canonical(),
            move || {
                Ok(Relay::new(url, move || {
                    cancelling.store(true, Ordering::SeqCst);
                    None
                }))
            },
            &cancel,
            binding,
        )
        .unwrap_err();
        assert_eq!(error, DownloadError::Cancelled);
        assert!(!destination.exists());
        assert_eq!(siblings(&parent), Vec::<String>::new());
    }

    /// A cancel that lands with the rename cannot unpublish it: the folder
    /// stays, complete, and the download is reported as interrupted.
    #[test]
    fn a_cancel_landing_with_publication_keeps_the_folder_and_is_not_success() {
        let temp = TempDir::new("download-cancel-landing");
        let Some(served) = served("a_cancel_landing_with_publication", &temp) else {
            return;
        };
        seed(
            &temp,
            &served.bare,
            &[("a.md", b"landed")],
            "refs/heads/main",
        );
        let parent = temp.folder("accounts");
        let destination = parent.join("so.epicenter.notes");
        let cancel = Arc::new(AtomicBool::new(false));
        let cancelling = Arc::clone(&cancel);
        BEFORE_PUBLISH.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move |_: &Path| {
                cancelling.store(true, Ordering::SeqCst);
            }))
        });
        let error = download(
            &parent,
            "so.epicenter.notes",
            &canonical(),
            relay_to(&served.url, &Journal::default(), destination.clone(), None),
            &cancel,
            binding,
        )
        .unwrap_err();
        BEFORE_PUBLISH.with(|hook| hook.borrow_mut().take());
        assert_eq!(
            error,
            DownloadError::Interrupted {
                root: destination.clone()
            }
        );
        assert_eq!(
            fs::read_to_string(destination.join("a.md")).unwrap(),
            "landed"
        );
        assert!(has_repository(&destination).unwrap());
    }

    #[test]
    fn a_download_cancelled_before_it_starts_transfers_nothing() {
        let temp = TempDir::new("download-cancel-early");
        let parent = temp.folder("accounts");
        let error = download(
            &parent,
            "so.epicenter.notes",
            &canonical(),
            || panic!("no transfer starts once cancelled"),
            &AtomicBool::new(true),
            |_| panic!("nothing is bound"),
        )
        .unwrap_err();
        assert_eq!(error, DownloadError::Cancelled);
        assert_eq!(siblings(&parent), Vec::<String>::new());
    }

    /// No listener is needed: nothing answers at the relay's port, and Git's
    /// own diagnostic names the URL it could not reach.
    #[test]
    fn a_failed_transfer_reports_what_the_relay_saw_and_never_shows_the_relay() {
        let temp = TempDir::new("download-failed");
        let parent = temp.folder("accounts");
        let destination = parent.join("so.epicenter.notes");
        let journal = Journal::default();
        let unreachable = format!("http://127.0.0.1:9/{TOKEN}/repo.git");
        let error = download(
            &parent,
            "so.epicenter.notes",
            &canonical(),
            relay_to(
                &unreachable,
                &journal,
                destination.clone(),
                Some("GitHub refused access for this transfer"),
            ),
            &AtomicBool::new(false),
            binding,
        )
        .unwrap_err();
        let DownloadError::Failed {
            message,
            staging: None,
        } = error
        else {
            panic!("an unkept failure, not {error:?}");
        };
        // Git's diagnostic survives, naming the canonical repository.
        assert!(message.starts_with("git fetch"), "{message}");
        assert!(message.contains("unable to access"), "{message}");
        assert!(message.contains(CANONICAL), "{message}");
        assert!(!message.contains(TOKEN), "{message}");
        assert!(!message.contains("/repo.git/'"), "{message}");
        assert!(
            message.ends_with("GitHub refused access for this transfer"),
            "{message}"
        );
        assert!(!destination.exists());
        assert_eq!(siblings(&parent), Vec::<String>::new());
    }

    #[test]
    fn a_transport_that_cannot_start_leaves_nothing() {
        let temp = TempDir::new("download-no-start");
        let parent = temp.folder("accounts");
        let error = download(
            &parent,
            "so.epicenter.notes",
            &canonical(),
            || Err("Sign in to Epicenter".to_string()),
            &AtomicBool::new(false),
            |_| panic!("nothing is bound"),
        )
        .unwrap_err();
        assert_eq!(
            error,
            DownloadError::Failed {
                message: "Sign in to Epicenter".to_string(),
                staging: None
            }
        );
        assert_eq!(siblings(&parent), Vec::<String>::new());
    }

    #[test]
    fn names_and_parents_that_cannot_hold_a_folder_are_refused() {
        let temp = TempDir::new("download-names");
        let parent = temp.folder("accounts");
        for name in ["", ".hidden", "a/b", "a\\b", ".."] {
            assert!(
                matches!(
                    download(
                        &parent,
                        name,
                        &canonical(),
                        || panic!("nothing starts"),
                        &AtomicBool::new(false),
                        |_| panic!("nothing is bound"),
                    ),
                    Err(DownloadError::Failed { staging: None, .. })
                ),
                "{name:?}"
            );
        }
        let linked = temp.path().join("linked");
        std::os::unix::fs::symlink(&parent, &linked).unwrap();
        assert!(matches!(
            download(
                &linked,
                "so.epicenter.notes",
                &canonical(),
                || panic!("nothing starts"),
                &AtomicBool::new(false),
                |_| panic!("nothing is bound"),
            ),
            Err(DownloadError::Failed { staging: None, .. })
        ));
        assert_eq!(siblings(&parent), Vec::<String>::new());
    }

    #[test]
    fn no_clobber_publication_refuses_every_kind_of_existing_entry() {
        let temp = TempDir::new("download-publish");
        for kind in ["empty directory", "directory", "file"] {
            let staged = temp.folder("staged");
            fs::write(staged.join("a.md"), "staged").unwrap();
            let target = temp.path().join("target");
            let _ = fs::remove_dir_all(&target);
            let _ = fs::remove_file(&target);
            match kind {
                "empty directory" => fs::create_dir(&target).unwrap(),
                "directory" => {
                    fs::create_dir(&target).unwrap();
                    fs::write(target.join("b.md"), "b").unwrap();
                }
                _ => fs::write(&target, "file").unwrap(),
            }
            let error = publish::no_clobber(&staged, &target).unwrap_err();
            assert_eq!(error.kind(), ErrorKind::AlreadyExists, "{kind}");
            assert_eq!(fs::read_to_string(staged.join("a.md")).unwrap(), "staged");
        }
        let staged = temp.path().join("staged");
        let fresh = temp.path().join("fresh");
        publish::no_clobber(&staged, &fresh).unwrap();
        assert_eq!(fs::read_to_string(fresh.join("a.md")).unwrap(), "staged");
        assert!(!staged.exists());
    }
}
