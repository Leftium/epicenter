//! Installed applications: which IDs a Bun generation serves, and the native
//! folder each one opens.
//!
//! Bun discovers the installed releases once at boot and names their IDs in
//! its ready frame. Rust never reads the catalog from disk; it checks that the
//! IDs can name managed folders (`read_ready_frame`), admits `app-` windows
//! only for the active generation's IDs (`admit_installed_app`), and registers
//! one Folder scope per ID on the first launch that creates its window.
//!
//! An installed app's folder is one dataset, named by its app ID, under the
//! owner the native process captured from Bun's first ready frame (ADR-0461):
//! `<folderDir>/local/<app-id>` for Local, and
//! `<folderDir>/accounts/<account-key>/<app-id>` for an account. A Local folder
//! is created on launch. An account folder is only opened: it arrives by an
//! explicit download, never by launching the app. The ID rules are the managed
//! folder-name rules in ADR-0488. Compiled Todos and Capture keep their
//! existing directories.
//!
//! The download (`download_dataset`) asks the active Bun generation for the
//! account's pairing of the folder whose ID is the app's ID, fetches it
//! through a relay into staging beside the destination, and publishes it only
//! where nothing is (`hosted.rs`, and the Folder core's `download`). It writes
//! the folder's binding (`binding.rs`): the one record of which repository was
//! selected. An account folder's owner gets a transport that relays each push
//! and fetch for exactly that repository; without a usable binding it refuses
//! transfers and nothing else.

use std::collections::BTreeSet;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, bail, Context, Result};
use tauri::{AppHandle, Runtime};
use tauri_plugin_epicenter_folder::{
    has_repository, Author, FolderConfig, FolderExt, ScopeConfig,
};

use crate::device_owner::{self, AccountIdentity};

mod binding;
mod hosted;

pub(crate) use hosted::{CurrentGeneration, Generation};

/// Folder scopes the compiled applications register at startup. An installed
/// app cannot take one: its scope ID is its app ID.
pub(crate) const TODOS_FOLDER_SCOPE: &str = "so.epicenter.todos";
pub(crate) const CAPTURE_FOLDER_SCOPE: &str = "so.epicenter.capture";

/// The owner directory under the folder root for account-independent data.
const LOCAL_OWNER: &str = "local";

/// The directory under the folder root that holds one child per account key.
const ACCOUNTS_OWNER: &str = "accounts";

/// A managed folder name is at most this many bytes (ADR-0488).
const MAX_FOLDER_NAME_BYTES: usize = 128;

/// Windows device basenames. Windows resolves `con.example` to the `CON`
/// device, so the label before the first dot must not be one of these.
const WINDOWS_DEVICE_NAMES: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Check one ID against the managed folder-name rules: two or more
/// dot-separated lowercase ASCII labels, each starting and ending with a letter
/// or digit and otherwise holding letters, digits, and hyphens; at most 128
/// bytes; no Windows device basename before the first dot. Nothing is escaped,
/// case-folded, or renamed.
pub(crate) fn check_folder_name(id: &str) -> Result<()> {
    if id.len() > MAX_FOLDER_NAME_BYTES {
        bail!("installed app id is longer than {MAX_FOLDER_NAME_BYTES} bytes: {id:?}");
    }
    let labels: Vec<&str> = id.split('.').collect();
    let is_edge = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
    let well_formed = labels.len() >= 2
        && labels.iter().all(|label| {
            let bytes = label.as_bytes();
            match (bytes.first(), bytes.last()) {
                (Some(&first), Some(&last)) => {
                    is_edge(first)
                        && is_edge(last)
                        && bytes.iter().all(|&byte| is_edge(byte) || byte == b'-')
                }
                _ => false,
            }
        });
    if !well_formed {
        bail!(
            "installed app id must be two or more lowercase dot-separated labels: {id:?}"
        );
    }
    if WINDOWS_DEVICE_NAMES.contains(&labels[0]) {
        bail!("installed app id begins with a reserved Windows device name: {id:?}");
    }
    Ok(())
}

/// Validate the installed IDs one ready frame names. Any invalid, duplicated,
/// or compiled-scope ID refuses the whole frame, so membership is never a
/// partial reading of what Bun sent.
pub(crate) fn validate_installed_ids(ids: Vec<String>) -> Result<Vec<String>> {
    let mut seen = BTreeSet::new();
    for id in &ids {
        check_folder_name(id)?;
        if id == TODOS_FOLDER_SCOPE || id == CAPTURE_FOLDER_SCOPE {
            bail!("installed app id names a compiled application's folder: {id:?}");
        }
        if !seen.insert(id.as_str()) {
            bail!("installed app id appears more than once: {id:?}");
        }
    }
    Ok(ids)
}

/// Make `<folder_dir>/local/<id>` exist and return it.
///
/// `folder_dir` is the root native startup captured; it is created when
/// missing and may itself be a link a person chose. `local` and the app's
/// directory are created one level at a time, and an existing one must be a
/// real directory: a symbolic link or a file there is refused, so the folder
/// never resolves outside the managed layout. This is checked when the window
/// opens; it does not defend against a later swap.
pub(crate) fn prepare_local_folder(folder_dir: &Path, id: &str) -> Result<PathBuf> {
    check_folder_name(id)?;
    fs::create_dir_all(folder_dir)
        .with_context(|| format!("create the folder root at {}", folder_dir.display()))?;
    if !folder_dir.is_dir() {
        bail!("the folder root at {} is not a directory", folder_dir.display());
    }
    let local = folder_dir.join(LOCAL_OWNER);
    ensure_real_directory(&local)?;
    let root = local.join(id);
    ensure_real_directory(&root)?;
    Ok(root)
}

/// Return `<folder_dir>/accounts/<account-key>/<id>` when it is already a Git
/// repository: one a download published, or a clone a person made.
///
/// Nothing is created. An account's dataset arrives by an explicit download,
/// and launching the app must not stand in for one, so a missing level
/// refuses with a request to download first. A directory that is there but is
/// not a repository, empty or holding files, is refused too, and left exactly
/// as it is: opening it would start a history unrelated to the account's.
/// `accounts`, the account directory, and the dataset must each be a real
/// directory, as in [`prepare_local_folder`]; the captured root may be a link
/// a person chose. Local is not read or touched. A missing or unusable
/// hosted record does not matter here; it only disables syncing.
pub(crate) fn open_account_folder(
    folder_dir: &Path,
    account: &AccountIdentity,
    id: &str,
) -> Result<PathBuf> {
    match locate_account_folder(folder_dir, account, id)? {
        AccountFolder::Repository(root) => Ok(root),
        AccountFolder::Absent(root) => bail!(
            "{id} has no data folder for this account on this device at {}. Download it explicitly before opening {id}.",
            root.display()
        ),
        AccountFolder::Unclaimed(root) => bail!("{}", unclaimed_message(id, &root)),
    }
}

/// What a person is told about a directory at an account dataset's path that
/// is not a repository: why it stays closed, and how to repair it by hand.
fn unclaimed_message(id: &str, root: &Path) -> String {
    format!(
        "{id}'s data folder for this account at {} is not a Git repository, so Epicenter will not open it, start a history in it, or download over it. Nothing in it was changed. To keep its files, move the folder somewhere else, download {id}, then copy the files you want back in.",
        root.display()
    )
}

/// Where an account's dataset stands on this device. Read from directory
/// entries alone; nothing records that a download happened.
#[derive(Debug, Clone, PartialEq, Eq)]
enum AccountFolder {
    /// Nothing at the path, or a level above it is missing.
    Absent(PathBuf),
    /// A real directory that is a Git repository (`has_repository`).
    Repository(PathBuf),
    /// A real directory that is not a repository: never opened or replaced.
    Unclaimed(PathBuf),
}

/// `<folder_dir>/accounts/<account-key>/<id>` and what is there, under the
/// rules of [`open_account_folder`].
fn locate_account_folder(
    folder_dir: &Path,
    account: &AccountIdentity,
    id: &str,
) -> Result<AccountFolder> {
    check_folder_name(id)?;
    let key = device_owner::account_key(account).map_err(|error| anyhow!(error))?;
    let accounts = folder_dir.join(ACCOUNTS_OWNER);
    let account_directory = accounts.join(&key);
    let root = account_directory.join(id);
    match fs::metadata(folder_dir) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => bail!("the folder root at {} is not a directory", folder_dir.display()),
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Ok(AccountFolder::Absent(root))
        }
        Err(error) => {
            return Err(error)
                .with_context(|| format!("inspect the folder root at {}", folder_dir.display()));
        }
    }
    let mut present = true;
    for level in [&accounts, &account_directory, &root] {
        if !is_real_directory(level)? {
            present = false;
            break;
        }
    }
    if !present {
        return Ok(AccountFolder::Absent(root));
    }
    Ok(if has_repository(&root).map_err(anyhow::Error::msg)? {
        AccountFolder::Repository(root)
    } else {
        AccountFolder::Unclaimed(root)
    })
}

/// Make `<folder_dir>/accounts/<account-key>` exist and return its canonical
/// path: the parent a download reserves its destination in and publishes
/// into. Only an explicit download calls this; launching never creates an
/// account directory. `accounts` and the account directory must be real
/// directories; the captured root may be a link a person chose.
pub(crate) fn prepare_account_parent(folder_dir: &Path, account: &AccountIdentity) -> Result<PathBuf> {
    let key = device_owner::account_key(account).map_err(|error| anyhow!(error))?;
    fs::create_dir_all(folder_dir)
        .with_context(|| format!("create the folder root at {}", folder_dir.display()))?;
    if !folder_dir.is_dir() {
        bail!("the folder root at {} is not a directory", folder_dir.display());
    }
    let accounts = folder_dir.join(ACCOUNTS_OWNER);
    ensure_real_directory(&accounts)?;
    let parent = accounts.join(key);
    ensure_real_directory(&parent)?;
    fs::canonicalize(&parent).with_context(|| format!("resolve {}", parent.display()))
}

/// What an installed app's data looks like on this device, without creating
/// or opening anything.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum InstalledData {
    /// Signed out: launching creates or opens the Local folder.
    Local,
    /// The account's dataset is a repository here; launching opens it. How
    /// it got here, a download or a clone, is not recorded or claimed.
    Available,
    /// The account's dataset is not here; it must be downloaded first.
    NotDownloaded,
    /// Something that is not a repository is at the dataset's path; it is
    /// neither opened nor downloaded over. The message says how to repair it.
    Unclaimed { message: String },
}

pub(crate) fn installed_data(
    folder_dir: &Path,
    owner: Option<&AccountIdentity>,
    id: &str,
) -> Result<InstalledData> {
    match owner {
        None => {
            check_folder_name(id)?;
            Ok(InstalledData::Local)
        }
        Some(account) => Ok(match locate_account_folder(folder_dir, account, id)? {
            AccountFolder::Repository(_) => InstalledData::Available,
            AccountFolder::Absent(_) => InstalledData::NotDownloaded,
            AccountFolder::Unclaimed(root) => InstalledData::Unclaimed {
                message: unclaimed_message(id, &root),
            },
        }),
    }
}

/// Download `account`'s dataset `id` to `<folderDir>/accounts/<key>/<id>`
/// from the repository its pairing names, recording that selection in it.
/// Refuses when anything is already there. `cancel` stops it before
/// publication; nothing is left behind then.
pub(crate) fn download_dataset(
    folder_dir: &Path,
    account: &AccountIdentity,
    id: &str,
    current: &CurrentGeneration,
    cancel: &AtomicBool,
) -> Result<PathBuf> {
    check_folder_name(id)?;
    let parent = prepare_account_parent(folder_dir, account)?;
    let root = hosted::download_dataset(&parent, account, id, current, cancel)
        .map_err(anyhow::Error::msg)?;
    // A cancel that arrives after the folder landed (quitting, or the Bun
    // generation that started it going away) leaves the folder where it is
    // and is reported, so nothing opens it as a finished download.
    if cancel.load(std::sync::atomic::Ordering::SeqCst) {
        bail!("{}", hosted::interrupted_message(&root));
    }
    Ok(root)
}

/// Prepare the folder `owner` holds for `id`: create the Local one, or open the
/// account one that is already there.
pub(crate) fn prepare_folder(
    folder_dir: &Path,
    owner: Option<&AccountIdentity>,
    id: &str,
) -> Result<PathBuf> {
    match owner {
        None => prepare_local_folder(folder_dir, id),
        Some(account) => open_account_folder(folder_dir, account, id),
    }
}

/// Whether `path` is a real directory, `false` when nothing is there. A link
/// or a file there is refused rather than reported missing.
fn is_real_directory(path: &Path) -> Result<bool> {
    let kind = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata.file_type(),
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(error).with_context(|| format!("inspect {}", path.display()));
        }
    };
    if kind.is_symlink() {
        bail!("{} is a symbolic link, not a folder Epicenter manages", path.display());
    }
    if !kind.is_dir() {
        bail!("{} is not a directory", path.display());
    }
    Ok(true)
}

fn ensure_real_directory(path: &Path) -> Result<()> {
    match fs::create_dir(path) {
        Ok(()) => return Ok(()),
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
        Err(error) => {
            return Err(error).with_context(|| format!("create {}", path.display()));
        }
    }
    if !is_real_directory(path)? {
        bail!("{} disappeared while it was being prepared", path.display());
    }
    Ok(())
}

/// Prepare an installed app's folder under `owner` and register it for
/// exactly its window, once for the native process.
///
/// `registered` holds the IDs already registered and outlives Bun restarts,
/// because the Folder plugin keeps a scope for the process lifetime and
/// refuses to register one twice. That is sound only because `owner` is the
/// one the native process captured and never changes: a scope's path is fixed
/// by the first registration. An ID is inserted only after registration
/// succeeds, so a refused attempt is retried by the next launch. The directory
/// is prepared on every launch that creates the window, so a deleted Local
/// folder is recreated, a deleted account folder is refused, and a swapped
/// link is refused before that window opens.
///
/// An account folder's pushes and fetches go through a relay of the current
/// Bun generation, for the repository its binding names (`hosted.rs`); its
/// `origin` stays that repository's canonical URL. A Local folder transfers
/// with whatever `origin` it has, as before.
///
/// The caller has already checked that the active Bun generation named `id`;
/// this function grants whatever ID it is given.
pub(crate) fn ensure_folder<R: Runtime>(
    app: &AppHandle<R>,
    registered: &Mutex<BTreeSet<String>>,
    folder_dir: &Path,
    owner: Option<&AccountIdentity>,
    current: CurrentGeneration,
    id: &str,
    window: &str,
) -> Result<()> {
    let root = prepare_folder(folder_dir, owner, id)?;
    let mut registered = registered
        .lock()
        .expect("installed folder registry lock poisoned");
    if registered.contains(id) {
        return Ok(());
    }
    let mut folder = FolderConfig::new(
        root,
        Author {
            name: id.to_string(),
            email: format!("{id}@localhost"),
        },
    );
    folder.use_repository_author = true;
    folder.use_repository_origin = true;
    // Checked again by the owner under the folder's lock: a `.git` that went
    // missing since `prepare_folder` refuses instead of starting new history.
    folder.require_existing_repository = owner.is_some();
    if let Some(account) = owner {
        folder.transport = Some(Arc::new(hosted::AccountTransport::new(
            account.clone(),
            id,
            current,
        )));
    }
    app.folders()
        .register(ScopeConfig {
            scope: id.to_string(),
            folder,
            windows: vec![window.to_string()],
        })
        .map_err(anyhow::Error::msg)
        .with_context(|| format!("register the folder for {id}"))?;
    registered.insert(id.to_string());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct TempDirectory(PathBuf);

    impl Drop for TempDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn temp(label: &str) -> TempDirectory {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "epicenter-installed-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        TempDirectory(path)
    }

    #[test]
    fn folder_names_follow_the_managed_rules() {
        for accepted in [
            "so.epicenter.zhongwen",
            "com.example.notes",
            "a.b",
            "x1.y-2.z3",
            "console.example",
            "com10.example",
            "example.con",
        ] {
            check_folder_name(accepted)
                .unwrap_or_else(|error| panic!("{accepted:?} refused: {error:#}"));
        }
        let longest = format!("a.{}", "b".repeat(MAX_FOLDER_NAME_BYTES - 2));
        assert_eq!(longest.len(), MAX_FOLDER_NAME_BYTES);
        check_folder_name(&longest).unwrap();

        let too_long = format!("{longest}b");
        for denied in [
            "",
            "zhongwen",
            "So.epicenter.zhongwen",
            "so..epicenter",
            ".so.epicenter",
            "so.epicenter.",
            "so.-epicenter",
            "so.epicenter-",
            "so_epicenter.app",
            "so.epicenter/app",
            "so.epicenter\\app",
            "so.épicenter",
            "con.example",
            "prn.example",
            "aux.example",
            "nul.example",
            "com1.example",
            "com9.example",
            "lpt1.example",
            "lpt9.example",
            too_long.as_str(),
        ] {
            assert!(check_folder_name(denied).is_err(), "{denied:?} accepted");
        }
    }

    #[test]
    fn a_frame_with_an_invalid_duplicate_or_compiled_id_is_refused_whole() {
        assert_eq!(
            validate_installed_ids(vec![
                "com.example.notes".into(),
                "so.epicenter.zhongwen".into()
            ])
            .unwrap(),
            ["com.example.notes", "so.epicenter.zhongwen"]
        );
        assert!(validate_installed_ids(Vec::new()).unwrap().is_empty());
        for invalid in [
            vec!["com.example.notes".to_string(), "com.example.notes".to_string()],
            vec!["com.example.notes".to_string(), "notes".to_string()],
            vec!["lpt3.example".to_string()],
            vec![TODOS_FOLDER_SCOPE.to_string()],
            vec![CAPTURE_FOLDER_SCOPE.to_string()],
        ] {
            assert!(validate_installed_ids(invalid.clone()).is_err(), "{invalid:?}");
        }
    }

    #[test]
    fn the_local_folder_is_created_under_the_captured_root() {
        let directory = temp("fresh");
        let folder_dir = directory.0.join("Epicenter Dev");

        let root = prepare_local_folder(&folder_dir, "so.epicenter.zhongwen").unwrap();

        assert_eq!(root, folder_dir.join("local").join("so.epicenter.zhongwen"));
        assert!(root.is_dir());
        // Nothing is created inside it: the Folder owner lays it out.
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        // Preparing again keeps what is there.
        fs::write(root.join("note.md"), "kept").unwrap();
        assert_eq!(
            prepare_local_folder(&folder_dir, "so.epicenter.zhongwen").unwrap(),
            root
        );
        assert_eq!(fs::read_to_string(root.join("note.md")).unwrap(), "kept");
    }

    #[test]
    fn a_file_where_the_local_or_app_folder_belongs_is_refused() {
        let directory = temp("file");
        let folder_dir = directory.0.clone();
        fs::write(folder_dir.join("local"), "not a folder").unwrap();
        assert!(prepare_local_folder(&folder_dir, "so.epicenter.zhongwen").is_err());
        assert_eq!(
            fs::read_to_string(folder_dir.join("local")).unwrap(),
            "not a folder"
        );

        let directory = temp("leaf-file");
        let folder_dir = directory.0.clone();
        fs::create_dir(folder_dir.join("local")).unwrap();
        let leaf = folder_dir.join("local").join("so.epicenter.zhongwen");
        fs::write(&leaf, "not a folder").unwrap();
        assert!(prepare_local_folder(&folder_dir, "so.epicenter.zhongwen").is_err());
        assert_eq!(fs::read_to_string(&leaf).unwrap(), "not a folder");
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_local_or_app_folder_is_refused() {
        let directory = temp("linked-local");
        let elsewhere = directory.0.join("elsewhere");
        fs::create_dir(&elsewhere).unwrap();
        let folder_dir = directory.0.join("root");
        fs::create_dir(&folder_dir).unwrap();
        std::os::unix::fs::symlink(&elsewhere, folder_dir.join("local")).unwrap();
        assert!(prepare_local_folder(&folder_dir, "so.epicenter.zhongwen").is_err());
        assert_eq!(fs::read_dir(&elsewhere).unwrap().count(), 0);

        let directory = temp("linked-leaf");
        let elsewhere = directory.0.join("elsewhere");
        fs::create_dir(&elsewhere).unwrap();
        let folder_dir = directory.0.join("root");
        fs::create_dir_all(folder_dir.join("local")).unwrap();
        std::os::unix::fs::symlink(
            &elsewhere,
            folder_dir.join("local").join("so.epicenter.zhongwen"),
        )
        .unwrap();
        assert!(prepare_local_folder(&folder_dir, "so.epicenter.zhongwen").is_err());

        // The captured root itself may be a link a person chose.
        let directory = temp("linked-root");
        let real = directory.0.join("real");
        fs::create_dir(&real).unwrap();
        let alias = directory.0.join("alias");
        std::os::unix::fs::symlink(&real, &alias).unwrap();
        let root = prepare_local_folder(&alias, "so.epicenter.zhongwen").unwrap();
        assert_eq!(root, alias.join("local").join("so.epicenter.zhongwen"));
        assert!(real.join("local").join("so.epicenter.zhongwen").is_dir());
    }

    #[test]
    fn an_id_outside_the_rules_creates_nothing() {
        let directory = temp("invalid");
        let folder_dir = directory.0.join("root");
        assert!(prepare_local_folder(&folder_dir, "../escape").is_err());
        assert!(prepare_local_folder(&folder_dir, "con.example").is_err());
        assert!(!folder_dir.exists());
    }

    fn account() -> AccountIdentity {
        AccountIdentity {
            authority_id: "epicenter-api".into(),
            principal_id: "user-123".into(),
        }
    }

    /// `account-key.test.ts`'s golden vector for `account()`.
    const ACCOUNT_KEY: &str = "b7efec8b3e072ff278fe2e331ce495dee36882be0ad2981c4e0196aeecbc1fc7";

    /// `git init` in `path`, as a download or a clone leaves an unborn `main`,
    /// with this machine's Git configuration kept out.
    fn init_repository(path: &Path) {
        let status = std::process::Command::new("git")
            .args(["init", "--quiet", "--initial-branch=main"])
            .current_dir(path)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .status()
            .unwrap();
        assert!(status.success());
    }

    #[test]
    fn only_a_repository_at_the_account_path_is_opened_and_anything_else_is_left_as_it_is() {
        let id = "so.epicenter.zhongwen";
        for (label, prepare) in [
            ("empty directory", (|_: &Path| {}) as fn(&Path)),
            ("files without history", |dataset: &Path| {
                fs::write(dataset.join("mine.md"), "mine").unwrap();
            }),
            ("an empty .git", |dataset: &Path| {
                fs::create_dir(dataset.join(".git")).unwrap();
            }),
        ] {
            let directory = temp("account-unclaimed");
            let folder_dir = directory.0.join("Epicenter");
            let dataset = folder_dir.join("accounts").join(ACCOUNT_KEY).join(id);
            fs::create_dir_all(&dataset).unwrap();
            prepare(&dataset);
            let before = tree(&folder_dir);
            let error = open_account_folder(&folder_dir, &account(), id).unwrap_err();
            let message = format!("{error:#}");
            assert!(message.contains("is not a Git repository"), "{label}: {message}");
            assert!(message.contains("move the folder somewhere else"), "{label}");
            assert!(matches!(
                installed_data(&folder_dir, Some(&account()), id).unwrap(),
                InstalledData::Unclaimed { .. }
            ));
            assert_eq!(tree(&folder_dir), before, "{label}: nothing was written");
        }

        // An unborn main, as an empty download leaves it, is a repository.
        let directory = temp("account-unborn");
        let folder_dir = directory.0.join("Epicenter");
        let dataset = folder_dir.join("accounts").join(ACCOUNT_KEY).join(id);
        fs::create_dir_all(&dataset).unwrap();
        init_repository(&dataset);
        assert_eq!(open_account_folder(&folder_dir, &account(), id).unwrap(), dataset);
        assert_eq!(
            installed_data(&folder_dir, Some(&account()), id).unwrap(),
            InstalledData::Available
        );
    }

    /// Every entry below `root`, so a refusal can be shown to write nothing.
    fn tree(root: &Path) -> Vec<PathBuf> {
        let mut entries = Vec::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(directory) = stack.pop() {
            for entry in fs::read_dir(&directory).unwrap() {
                let path = entry.unwrap().path();
                if fs::symlink_metadata(&path).unwrap().is_dir() {
                    stack.push(path.clone());
                }
                entries.push(path);
            }
        }
        entries.sort();
        entries
    }

    #[test]
    fn an_account_folder_opens_under_its_account_key_and_leaves_local_alone() {
        let directory = temp("account");
        let folder_dir = directory.0.join("Epicenter");
        let id = "so.epicenter.zhongwen";
        let local = prepare_local_folder(&folder_dir, id).unwrap();
        fs::write(local.join("local.md"), "local").unwrap();
        let dataset = folder_dir.join("accounts").join(ACCOUNT_KEY).join(id);
        fs::create_dir_all(&dataset).unwrap();
        init_repository(&dataset);
        fs::write(dataset.join("account.md"), "account").unwrap();
        let before = tree(&folder_dir);

        assert_eq!(prepare_folder(&folder_dir, Some(&account()), id).unwrap(), dataset);
        assert_eq!(tree(&folder_dir), before);
        assert_eq!(fs::read_to_string(local.join("local.md")).unwrap(), "local");
        // Local is still what a Local owner opens.
        assert_eq!(prepare_folder(&folder_dir, None, id).unwrap(), local);
    }

    #[test]
    fn a_missing_account_dataset_asks_for_a_download_and_creates_nothing() {
        let id = "so.epicenter.zhongwen";

        // No folder root at all.
        let directory = temp("account-no-root");
        let folder_dir = directory.0.join("Epicenter");
        let error = open_account_folder(&folder_dir, &account(), id).unwrap_err();
        assert!(format!("{error:#}").contains("Download it explicitly before opening"));
        assert!(!folder_dir.exists());

        // A root holding only Local data, then each missing level in turn.
        let directory = temp("account-missing");
        let folder_dir = directory.0.clone();
        fs::create_dir_all(folder_dir.join("local").join(id)).unwrap();
        fs::write(folder_dir.join("local").join(id).join("note.md"), "kept").unwrap();
        for existing in [
            None,
            Some(folder_dir.join("accounts")),
            Some(folder_dir.join("accounts").join(ACCOUNT_KEY)),
        ] {
            if let Some(existing) = existing {
                fs::create_dir(existing).unwrap();
            }
            let before = tree(&folder_dir);
            let error = open_account_folder(&folder_dir, &account(), id).unwrap_err();
            assert!(
                format!("{error:#}").contains("Download it explicitly before opening"),
                "{error:#}"
            );
            assert_eq!(tree(&folder_dir), before);
        }
        // Another account's dataset is not this account's.
        let other = folder_dir.join("accounts").join("0".repeat(64)).join(id);
        fs::create_dir_all(&other).unwrap();
        assert!(open_account_folder(&folder_dir, &account(), id).is_err());
        assert_eq!(
            fs::read_to_string(folder_dir.join("local").join(id).join("note.md")).unwrap(),
            "kept"
        );
    }

    #[test]
    fn a_file_where_an_account_level_belongs_is_refused() {
        let id = "so.epicenter.zhongwen";
        let accounts = |root: &Path| root.join("accounts");
        let key = |root: &Path| root.join("accounts").join(ACCOUNT_KEY);
        for depth in 0..3 {
            let directory = temp("account-file");
            let folder_dir = directory.0.clone();
            let levels = [accounts(&folder_dir), key(&folder_dir), key(&folder_dir).join(id)];
            for level in &levels[..depth] {
                fs::create_dir(level).unwrap();
            }
            fs::write(&levels[depth], "not a folder").unwrap();
            let error = open_account_folder(&folder_dir, &account(), id).unwrap_err();
            assert!(format!("{error:#}").contains("is not a directory"), "{error:#}");
            assert_eq!(fs::read_to_string(&levels[depth]).unwrap(), "not a folder");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_account_level_is_refused() {
        let id = "so.epicenter.zhongwen";
        for depth in 0..3 {
            let directory = temp("account-link");
            let elsewhere = directory.0.join("elsewhere");
            // A complete dataset outside the managed layout, at every depth.
            fs::create_dir_all(elsewhere.join(ACCOUNT_KEY).join(id)).unwrap();
            let folder_dir = directory.0.join("root");
            let levels = [
                folder_dir.join("accounts"),
                folder_dir.join("accounts").join(ACCOUNT_KEY),
                folder_dir.join("accounts").join(ACCOUNT_KEY).join(id),
            ];
            fs::create_dir(&folder_dir).unwrap();
            for level in &levels[..depth] {
                fs::create_dir(level).unwrap();
            }
            let target = match depth {
                0 => elsewhere.clone(),
                1 => elsewhere.join(ACCOUNT_KEY),
                _ => elsewhere.join(ACCOUNT_KEY).join(id),
            };
            std::os::unix::fs::symlink(&target, &levels[depth]).unwrap();
            let error = open_account_folder(&folder_dir, &account(), id).unwrap_err();
            assert!(format!("{error:#}").contains("symbolic link"), "{error:#}");
        }

        // The captured root itself may be a link a person chose.
        let directory = temp("account-linked-root");
        let real = directory.0.join("real");
        let dataset = real.join("accounts").join(ACCOUNT_KEY).join(id);
        fs::create_dir_all(&dataset).unwrap();
        init_repository(&dataset);
        let alias = directory.0.join("alias");
        std::os::unix::fs::symlink(&real, &alias).unwrap();
        assert_eq!(
            open_account_folder(&alias, &account(), id).unwrap(),
            alias.join("accounts").join(ACCOUNT_KEY).join(id)
        );
    }

    #[test]
    fn an_account_folder_refuses_an_invalid_id_or_identity() {
        let directory = temp("account-invalid");
        assert!(open_account_folder(&directory.0, &account(), "../escape").is_err());
        let invalid = AccountIdentity {
            authority_id: "epicenter-api".into(),
            principal_id: "user\n".into(),
        };
        assert!(open_account_folder(&directory.0, &invalid, "so.epicenter.zhongwen").is_err());
        assert!(tree(&directory.0).is_empty());
    }

    #[test]
    fn a_folder_is_registered_once_for_its_window_and_only_after_success() {
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_epicenter_folder::init())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let handle = app.handle();
        let registered = Mutex::new(BTreeSet::new());
        let directory = temp("register");
        let id = "so.epicenter.zhongwen";

        let window = "app-so_epicenter_zhongwen";
        ensure_folder(handle, &registered, &directory.0, None, no_generation(), id, window)
            .unwrap();
        // The plugin refuses a second registration of one scope, so a second
        // launch, including one after a Bun restart, must not ask again.
        ensure_folder(handle, &registered, &directory.0, None, no_generation(), id, window)
            .unwrap();
        assert_eq!(registered.lock().unwrap().iter().collect::<Vec<_>>(), [id]);

        // A refused preparation registers nothing and records nothing.
        let blocked = temp("register-blocked");
        fs::write(blocked.0.join("local"), "not a folder").unwrap();
        assert!(ensure_folder(
            handle,
            &registered,
            &blocked.0,
            None,
            no_generation(),
            "com.example.notes",
            "app-com_example_notes"
        )
        .is_err());
        assert!(!registered.lock().unwrap().contains("com.example.notes"));

        // So does an account dataset that was never downloaded.
        assert!(ensure_folder(
            handle,
            &registered,
            &directory.0,
            Some(&account()),
            no_generation(),
            "com.example.notes",
            "app-com_example_notes"
        )
        .is_err());
        assert!(!registered.lock().unwrap().contains("com.example.notes"));
        assert!(!directory.0.join("accounts").exists());

        // A refused registration is not recorded, so the next launch retries.
        handle
            .folders()
            .register(ScopeConfig {
                scope: "com.example.taken".into(),
                folder: FolderConfig::new(
                    directory.0.join("elsewhere"),
                    Author {
                        name: "Other".into(),
                        email: "other@localhost".into(),
                    },
                ),
                windows: vec!["other".into()],
            })
            .unwrap();
        assert!(ensure_folder(
            handle,
            &registered,
            &directory.0,
            None,
            no_generation(),
            "com.example.taken",
            "app-com_example_taken"
        )
        .is_err());
        assert!(!registered.lock().unwrap().contains("com.example.taken"));
    }

    /// No Bun generation: a transport built with this starts nothing.
    fn no_generation() -> CurrentGeneration {
        Arc::new(|| None)
    }

    #[test]
    fn a_download_parent_is_the_canonical_account_directory_and_nothing_else() {
        let directory = temp("download-parent");
        let real = directory.0.join("Real Epicenter");
        fs::create_dir(&real).unwrap();
        // The captured root may be a link a person chose.
        let folder_dir = directory.0.join("Epicenter");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, &folder_dir).unwrap();
        #[cfg(not(unix))]
        let folder_dir = real.clone();

        let parent = prepare_account_parent(&folder_dir, &account()).unwrap();
        assert_eq!(
            parent,
            fs::canonicalize(&real).unwrap().join("accounts").join(ACCOUNT_KEY)
        );
        // Only the account directory: no dataset, and Local untouched.
        assert_eq!(fs::read_dir(&parent).unwrap().count(), 0);
        assert!(!real.join("local").exists());
        assert_eq!(prepare_account_parent(&folder_dir, &account()).unwrap(), parent);
    }

    #[cfg(unix)]
    #[test]
    fn a_download_parent_refuses_a_linked_account_level() {
        let directory = temp("download-parent-link");
        let outside = directory.0.join("outside");
        fs::create_dir(&outside).unwrap();
        let folder_dir = directory.0.join("Epicenter");
        fs::create_dir(&folder_dir).unwrap();
        std::os::unix::fs::symlink(&outside, folder_dir.join("accounts")).unwrap();
        assert!(prepare_account_parent(&folder_dir, &account()).is_err());
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
    }

    #[test]
    fn installed_data_reads_what_is_there_and_creates_nothing() {
        let directory = temp("installed-data");
        let folder_dir = directory.0.join("Epicenter");
        let id = "com.bradenwong.zhongwen";
        assert_eq!(installed_data(&folder_dir, None, id).unwrap(), InstalledData::Local);
        assert_eq!(
            installed_data(&folder_dir, Some(&account()), id).unwrap(),
            InstalledData::NotDownloaded
        );
        assert!(!folder_dir.exists());
        let dataset = folder_dir.join("accounts").join(ACCOUNT_KEY).join(id);
        fs::create_dir_all(&dataset).unwrap();
        // A directory alone is not data that is available here.
        assert!(matches!(
            installed_data(&folder_dir, Some(&account()), id).unwrap(),
            InstalledData::Unclaimed { .. }
        ));
        init_repository(&dataset);
        assert_eq!(
            installed_data(&folder_dir, Some(&account()), id).unwrap(),
            InstalledData::Available
        );
        assert!(installed_data(&folder_dir, Some(&account()), "../escape").is_err());
        assert!(installed_data(&folder_dir, None, "../escape").is_err());
    }
}
