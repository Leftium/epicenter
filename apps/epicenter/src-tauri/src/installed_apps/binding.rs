//! Which hosted repository an account dataset was explicitly downloaded from.
//!
//! One credential-free file, `.git/epicenter/hosted.json`, inside the dataset
//! it describes. It records the exact account, the folder ID, the GitHub
//! repository ID and pairing revision that were selected, and the canonical
//! clone URL and branch `origin` names. Only an explicit download writes it,
//! and it is never replaced: discovery reads pairings but never changes what a
//! folder was bound to, and a replacement repository at the same URL arrives
//! with another ID and revision, which the connector refuses for this one.
//!
//! The folder's owner reads it under the folder's lock each time a transfer
//! starts. A missing, malformed, linked, or foreign record refuses hosted
//! transfers for that folder and nothing else; editing never reads it. A raw
//! Git clone does not carry it, because `.git/epicenter` is private.
//!
//! The account identity is an address, not a credential: no token, cookie, or
//! GitHub grant is ever written here.

use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::device_owner::AccountIdentity;

/// The record's name inside `.git/epicenter`.
pub(crate) const BINDING_FILE: &str = "hosted.json";
const VERSION: u32 = 1;
/// The branch every hosted dataset transfers (ADR-0488).
pub(crate) const HOSTED_BRANCH: &str = "main";
/// A record is a few hundred bytes; anything far larger is not one.
const MAX_BYTES: u64 = 4096;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Binding {
    pub version: u32,
    pub account: AccountIdentity,
    pub folder_id: String,
    pub repository: Repository,
    pub revision: String,
    pub remote: BoundRemote,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Repository {
    /// GitHub's repository ID: the identity a URL is not.
    pub id: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BoundRemote {
    pub url: String,
    pub branch: String,
}

/// Why a folder has no usable binding. Each refuses hosted transfers only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum BindingError {
    /// No record: the folder was never downloaded here.
    Missing,
    /// A well-formed record for another account or another folder.
    Foreign,
    /// A record that cannot be trusted: linked, not a file, oversized,
    /// unreadable, or malformed.
    Unusable(String),
}

impl BindingError {
    /// What a person is told when a transfer is refused for this reason.
    pub(crate) fn message(&self) -> String {
        match self {
            Self::Missing => "This folder was not downloaded from a GitHub repository on this device, so Epicenter does not sync it. Editing still works.".to_string(),
            Self::Foreign => "This folder's GitHub record belongs to another account or folder, so Epicenter does not sync it. Editing still works.".to_string(),
            Self::Unusable(reason) => format!(
                "This folder's GitHub record cannot be used ({reason}), so Epicenter does not sync it. Editing still works."
            ),
        }
    }
}

/// `https://github.com/<owner>/<name>.git`, exactly as the connector reports
/// a clone URL and as the browser's transport checks it.
pub(crate) fn is_canonical_clone_url(url: &str) -> bool {
    let Some(path) = url.strip_prefix("https://github.com/") else {
        return false;
    };
    let Some((owner, name)) = path.split_once('/') else {
        return false;
    };
    let Some(stem) = name.strip_suffix(".git") else {
        return false;
    };
    let allowed = |segment: &str| {
        !segment.is_empty()
            && segment
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
    };
    allowed(owner) && owner != "." && owner != ".." && allowed(stem) && !name.contains('/')
}

/// A connector pairing revision: 22 base64url characters.
pub(crate) fn is_revision(value: &str) -> bool {
    value.len() == 22
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

impl Binding {
    /// A record of one explicit selection, checked before anything holds it.
    pub(crate) fn new(
        account: AccountIdentity,
        folder_id: &str,
        repository_id: u64,
        revision: &str,
        url: &str,
    ) -> Result<Self, String> {
        let binding = Self {
            version: VERSION,
            account,
            folder_id: folder_id.to_string(),
            repository: Repository { id: repository_id },
            revision: revision.to_string(),
            remote: BoundRemote {
                url: url.to_string(),
                branch: HOSTED_BRANCH.to_string(),
            },
        };
        binding.validate()?;
        Ok(binding)
    }

    fn validate(&self) -> Result<(), String> {
        if self.version != VERSION {
            return Err(format!("version {} is not {VERSION}", self.version));
        }
        for value in [&self.account.authority_id, &self.account.principal_id] {
            if value.is_empty() || value.chars().any(char::is_control) {
                return Err("the account is not an identity".to_string());
            }
        }
        if self.folder_id.is_empty() || self.folder_id.len() > 128 {
            return Err("the folder ID is not one".to_string());
        }
        if self.repository.id == 0 || self.repository.id > (1 << 53) {
            return Err("the repository ID is not one".to_string());
        }
        if !is_revision(&self.revision) {
            return Err("the pairing revision is not one".to_string());
        }
        if !is_canonical_clone_url(&self.remote.url) {
            return Err("the repository URL is not a GitHub clone URL".to_string());
        }
        if self.remote.branch != HOSTED_BRANCH {
            return Err(format!("the branch is not {HOSTED_BRANCH}"));
        }
        Ok(())
    }
}

/// The path of `root`'s record, without reading anything.
pub(crate) fn path(root: &Path) -> PathBuf {
    root.join(".git").join("epicenter").join(BINDING_FILE)
}

/// Whether `path` is a real directory: `Ok(false)` when absent, an error when
/// a link or anything else is there.
fn real_directory(path: &Path, label: &str) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(found) if found.file_type().is_symlink() => Err(format!("{label} is a symbolic link")),
        Ok(found) if found.is_dir() => Ok(true),
        Ok(_) => Err(format!("{label} is not a directory")),
        Err(cause) if cause.kind() == ErrorKind::NotFound => Ok(false),
        Err(cause) => Err(format!("{label} could not be inspected: {cause}")),
    }
}

/// Write `binding` into the folder at `root`, which has a real `.git`.
/// `.git/epicenter` is created when absent. An existing record, or anything
/// at its path, is never replaced.
pub(crate) fn write_new(root: &Path, binding: &Binding) -> Result<(), String> {
    binding.validate()?;
    let git = root.join(".git");
    if !real_directory(&git, ".git")? {
        return Err(".git is missing".to_string());
    }
    let private = git.join("epicenter");
    match fs::create_dir(&private) {
        Ok(()) => {}
        Err(cause) if cause.kind() == ErrorKind::AlreadyExists => {}
        Err(cause) => return Err(format!("create .git/epicenter: {cause}")),
    }
    if !real_directory(&private, ".git/epicenter")? {
        return Err(".git/epicenter disappeared".to_string());
    }
    let mut bytes = serde_json::to_vec_pretty(binding).map_err(|cause| cause.to_string())?;
    bytes.push(b'\n');
    // Exclusive creation also refuses a link left at the path.
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(private.join(BINDING_FILE))
        .map_err(|cause| match cause.kind() {
            ErrorKind::AlreadyExists => {
                "this folder already records a GitHub repository, which is never replaced"
                    .to_string()
            }
            _ => format!("write the GitHub record: {cause}"),
        })?;
    file.write_all(&bytes)
        .and_then(|()| file.sync_all())
        .map_err(|cause| format!("write the GitHub record: {cause}"))
}

/// Read the record of the folder at `root`, which must be `account`'s
/// `folder_id`. The caller holds the folder's lock.
pub(crate) fn load(
    root: &Path,
    account: &AccountIdentity,
    folder_id: &str,
) -> Result<Binding, BindingError> {
    let unusable = BindingError::Unusable;
    for (directory, label) in [
        (root.join(".git"), ".git"),
        (root.join(".git").join("epicenter"), ".git/epicenter"),
    ] {
        if !real_directory(&directory, label).map_err(unusable)? {
            return Err(BindingError::Missing);
        }
    }
    let file = path(root);
    match fs::symlink_metadata(&file) {
        Ok(found) if found.file_type().is_symlink() => {
            return Err(unusable("it is a symbolic link".to_string()))
        }
        Ok(found) if !found.is_file() => return Err(unusable("it is not a file".to_string())),
        Ok(_) => {}
        Err(cause) if cause.kind() == ErrorKind::NotFound => return Err(BindingError::Missing),
        Err(cause) => return Err(unusable(format!("it could not be inspected: {cause}"))),
    }
    let mut options = OpenOptions::new();
    options.read(true);
    // A link swapped in after the check above is refused by the open itself.
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut bytes = Vec::new();
    options
        .open(&file)
        .and_then(|handle| handle.take(MAX_BYTES + 1).read_to_end(&mut bytes))
        .map_err(|cause| unusable(format!("it could not be read: {cause}")))?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(unusable("it is too large".to_string()));
    }
    let binding: Binding = serde_json::from_slice(&bytes)
        .map_err(|_| unusable("it is not a GitHub record Epicenter wrote".to_string()))?;
    binding.validate().map_err(unusable)?;
    if binding.account != *account || binding.folder_id != folder_id {
        return Err(BindingError::Foreign);
    }
    Ok(binding)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct Directory(PathBuf);

    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// A folder with a real, empty `.git`.
    fn folder(label: &str) -> Directory {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "epicenter-binding-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(path.join(".git")).unwrap();
        Directory(path)
    }

    fn alice() -> AccountIdentity {
        AccountIdentity {
            authority_id: "epicenter-api".into(),
            principal_id: "user-123".into(),
        }
    }

    const FOLDER: &str = "com.bradenwong.zhongwen";
    const REVISION: &str = "AbCdEfGhIjKlMnOpQrSt_-";
    const URL: &str = "https://github.com/alice/zhongwen.git";

    fn binding() -> Binding {
        Binding::new(alice(), FOLDER, 9001, REVISION, URL).unwrap()
    }

    #[test]
    fn a_written_record_reads_back_exactly_and_holds_no_credential() {
        let root = folder("roundtrip");
        write_new(&root.0, &binding()).unwrap();
        assert_eq!(load(&root.0, &alice(), FOLDER).unwrap(), binding());
        let text = fs::read_to_string(path(&root.0)).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&text).unwrap(),
            serde_json::json!({
                "version": 1,
                "account": { "authorityId": "epicenter-api", "principalId": "user-123" },
                "folderId": FOLDER,
                "repository": { "id": 9001 },
                "revision": REVISION,
                "remote": { "url": URL, "branch": "main" },
            })
        );
        for secret in ["token", "Bearer", "authorization", "cookie"] {
            assert!(
                !text.to_lowercase().contains(&secret.to_lowercase()),
                "{secret}"
            );
        }
    }

    #[test]
    fn a_record_is_never_replaced_even_by_the_same_url_with_another_repository() {
        let root = folder("never-replaced");
        write_new(&root.0, &binding()).unwrap();
        let replacement =
            Binding::new(alice(), FOLDER, 9002, "ZZZZZZZZZZZZZZZZZZZZZZ", URL).unwrap();
        let error = write_new(&root.0, &replacement).unwrap_err();
        assert!(error.contains("never replaced"), "{error}");
        assert_eq!(load(&root.0, &alice(), FOLDER).unwrap().repository.id, 9001);
    }

    #[test]
    fn missing_foreign_linked_and_malformed_records_refuse_only_transfers() {
        let root = folder("refusals");
        assert_eq!(load(&root.0, &alice(), FOLDER), Err(BindingError::Missing));
        fs::create_dir(root.0.join(".git/epicenter")).unwrap();
        assert_eq!(load(&root.0, &alice(), FOLDER), Err(BindingError::Missing));

        write_new(&root.0, &binding()).unwrap();
        let other_account = AccountIdentity {
            authority_id: "epicenter-api".into(),
            principal_id: "user-456".into(),
        };
        assert_eq!(
            load(&root.0, &other_account, FOLDER),
            Err(BindingError::Foreign)
        );
        assert_eq!(
            load(&root.0, &alice(), "com.example.notes"),
            Err(BindingError::Foreign)
        );

        for malformed in [
            "not json".to_string(),
            "{}".to_string(),
            serde_json::to_string(&serde_json::json!({
                "version": 1, "account": { "authorityId": "epicenter-api", "principalId": "user-123" },
                "folderId": FOLDER, "repository": { "id": 9001 }, "revision": REVISION,
                "remote": { "url": URL, "branch": "main" }, "token": "secret",
            }))
            .unwrap(),
            serde_json::to_string(&serde_json::json!({
                "version": 1, "account": { "authorityId": "epicenter-api", "principalId": "user-123" },
                "folderId": FOLDER, "repository": { "id": 9001 }, "revision": REVISION,
                "remote": { "url": "https://evil.test/alice/zhongwen.git", "branch": "main" },
            }))
            .unwrap(),
            serde_json::to_string(&serde_json::json!({
                "version": 1, "account": { "authorityId": "epicenter-api", "principalId": "user-123" },
                "folderId": FOLDER, "repository": { "id": 9001 }, "revision": REVISION,
                "remote": { "url": URL, "branch": "trunk" },
            }))
            .unwrap(),
            " ".repeat(MAX_BYTES as usize + 1),
        ] {
            fs::write(path(&root.0), &malformed).unwrap();
            assert!(
                matches!(load(&root.0, &alice(), FOLDER), Err(BindingError::Unusable(_))),
                "{malformed:.80}"
            );
        }
        fs::remove_file(path(&root.0)).unwrap();
        fs::create_dir(path(&root.0)).unwrap();
        assert!(matches!(
            load(&root.0, &alice(), FOLDER),
            Err(BindingError::Unusable(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_record_or_private_directory_is_refused_and_never_written_through() {
        let root = folder("linked");
        let elsewhere = folder("elsewhere");
        fs::create_dir(root.0.join(".git/epicenter")).unwrap();
        write_new(&elsewhere.0, &binding()).unwrap();
        std::os::unix::fs::symlink(path(&elsewhere.0), path(&root.0)).unwrap();
        assert!(
            matches!(load(&root.0, &alice(), FOLDER), Err(BindingError::Unusable(reason)) if reason.contains("symbolic link"))
        );
        assert!(write_new(&root.0, &binding()).is_err());

        let linked = folder("linked-private");
        std::os::unix::fs::symlink(
            elsewhere.0.join(".git/epicenter"),
            linked.0.join(".git/epicenter"),
        )
        .unwrap();
        assert!(matches!(
            load(&linked.0, &alice(), FOLDER),
            Err(BindingError::Unusable(_))
        ));
        let before = fs::read(path(&elsewhere.0)).unwrap();
        assert!(write_new(&linked.0, &binding()).is_err());
        assert_eq!(fs::read(path(&elsewhere.0)).unwrap(), before);
    }

    #[test]
    fn only_canonical_github_clone_urls_and_revisions_are_records() {
        for url in [
            URL,
            "https://github.com/a-b/c.d_e.git",
            "https://github.com/a/..git",
        ] {
            assert!(is_canonical_clone_url(url), "{url}");
        }
        for url in [
            "http://github.com/a/b.git",
            "https://github.com/a/b",
            "https://github.com/a/b/c.git",
            "https://github.com/../b.git",
            "https://github.com/a/.git",
            "https://user@github.com/a/b.git",
            "https://github.com:443/a/b.git",
            "https://github.com/a/b.git?x=1",
            "https://github.com/a/b.git#x",
            "https://github.com.evil.test/a/b.git",
            "https://github.com/a%2fb/c.git",
        ] {
            assert!(!is_canonical_clone_url(url), "{url}");
        }
        assert!(is_revision(REVISION));
        for revision in [
            "",
            "short",
            "AbCdEfGhIjKlMnOpQrSt_-x",
            "AbCdEfGhIjKlMnOpQrSt/-",
        ] {
            assert!(!is_revision(revision), "{revision}");
        }
        assert!(Binding::new(alice(), FOLDER, 0, REVISION, URL).is_err());
    }
}
