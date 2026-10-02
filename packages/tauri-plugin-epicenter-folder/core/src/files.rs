//! Ordinary files in a native folder.
//!
//! The Rust owner of what `packages/app/src/files/native-store.ts` does for a
//! Bun process. Current files are the source. A conditional write hashes the
//! current bytes and replaces them only when they match; this is a best-effort
//! check, not an operating-system-wide compare-and-swap against other
//! programs. Exclusive creation and moves use hard links, which fail rather
//! than overwrite an existing destination. Replacement writes a scratch file
//! under `.git/epicenter/scratch`, checks the expected version again, and
//! renames the scratch file into place.
//!
//! A multi-file batch applies ordered steps. When a step fails, the result
//! reports which steps reached the folder; nothing is rolled back.
//!
//! Nothing here serializes batches. The folder owner applies one batch at a
//! time, so every window's saves check against what the previous one left.

use std::fs;
use std::io::{self, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use specta::Type;

use crate::paths::{ancestors, path_problem};

/// SHA-256 plus byte length of one file's exact bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct FileVersion {
    pub sha256: String,
    pub size: u64,
}

impl FileVersion {
    pub fn of(bytes: &[u8]) -> Self {
        Self {
            sha256: Sha256::digest(bytes)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect(),
            size: bytes.len() as u64,
        }
    }
}

/// The condition a write checks at its publication point.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FileExpectation {
    /// No file at the path (exclusive creation).
    Absent,
    /// A deliberate overwrite.
    Any,
    /// The current bytes are exactly these.
    Version { sha256: String, size: u64 },
}

impl FileExpectation {
    pub fn version(version: &FileVersion) -> Self {
        Self::Version {
            sha256: version.sha256.clone(),
            size: version.size,
        }
    }

    fn satisfied_by(&self, current: Option<&FileVersion>) -> bool {
        match self {
            Self::Any => true,
            Self::Absent => current.is_none(),
            Self::Version { sha256, size } => {
                current.is_some_and(|current| current.sha256 == *sha256 && current.size == *size)
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct FileRead {
    pub bytes: Vec<u8>,
    pub version: FileVersion,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct ListedFile {
    pub path: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Type)]
pub struct FileListing {
    /// Every regular file, including files outside portable scope.
    pub files: Vec<ListedFile>,
    /// Every directory, including empty ones.
    pub directories: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Type)]
pub struct Children {
    pub files: Vec<String>,
    pub directories: Vec<String>,
}

/// One conditional step. The new version is computed here, never accepted
/// from the caller.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FileChange {
    Write {
        path: String,
        bytes: Vec<u8>,
        expected: FileExpectation,
    },
    Remove {
        path: String,
        expected: FileExpectation,
    },
    /// Moves exact bytes; the destination must be absent.
    Move {
        from: String,
        to: String,
        expected: FileExpectation,
    },
}

impl FileChange {
    fn paths(&self) -> Vec<&str> {
        match self {
            Self::Write { path, .. } | Self::Remove { path, .. } => vec![path],
            Self::Move { from, to, .. } => vec![from, to],
        }
    }

    pub fn step(&self) -> FileStep {
        match self {
            Self::Write { path, .. } => FileStep::Write { path: path.clone() },
            Self::Remove { path, .. } => FileStep::Remove { path: path.clone() },
            Self::Move { from, to, .. } => FileStep::Move {
                from: from.clone(),
                to: to.clone(),
            },
        }
    }
}

/// A step that reached, or failed to reach, the folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FileStep {
    Write { path: String },
    Remove { path: String },
    Move { from: String, to: String },
}

impl FileStep {
    /// Every path this step touched.
    pub fn paths(&self) -> Vec<&str> {
        match self {
            Self::Write { path } | Self::Remove { path } => vec![path],
            Self::Move { from, to } => vec![from, to],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "name")]
pub enum FileError {
    InvalidPath {
        path: String,
        reason: String,
    },
    NotFound {
        path: String,
    },
    Conflict {
        path: String,
        expected: FileExpectation,
        actual: Option<FileVersion>,
    },
    NotAFile {
        path: String,
    },
    NotADirectory {
        path: String,
    },
    DirectoryNotEmpty {
        path: String,
    },
    Io {
        path: String,
        operation: String,
        cause: String,
    },
    Closed,
    /// The operation started and its outcome is unknown: it may have reached
    /// the folder. Look before trying again.
    Unconfirmed {
        path: String,
        operation: String,
        cause: String,
    },
    /// The caller has no session for this folder, or names another window's.
    Denied {
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "name")]
pub enum ApplyError {
    /// A refusal before anything landed: nothing was written.
    Refused { error: FileError },
    /// The batch stopped partway. `applied` steps reached the folder; nothing
    /// was rolled back. `failed` did not complete, `notAttempted` never started.
    #[serde(rename_all = "camelCase")]
    Partial {
        applied: Vec<FileStep>,
        failed: FileStep,
        error: FileError,
        not_attempted: Vec<FileStep>,
    },
    /// The batch started and its outcome is unknown: any of its steps may
    /// have reached the folder. Look before trying again.
    Unconfirmed {
        path: String,
        operation: String,
        cause: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    File,
    Directory,
    Absent,
}

fn io(path: &str, operation: &str, cause: &io::Error) -> FileError {
    FileError::Io {
        path: path.to_string(),
        operation: operation.to_string(),
        cause: cause.to_string(),
    }
}

fn invalid(path: &str) -> Result<(), FileError> {
    match path_problem(path) {
        None => Ok(()),
        Some(reason) => Err(FileError::InvalidPath {
            path: path.to_string(),
            reason: reason.to_string(),
        }),
    }
}

static SCRATCH_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// File operations under one canonical root.
#[derive(Debug, Clone)]
pub struct Files {
    root: PathBuf,
    scratch: PathBuf,
}

impl Files {
    /// `root` is already canonical and its private Git layout verified.
    pub fn new(root: &Path) -> Self {
        Self {
            root: root.to_path_buf(),
            scratch: root.join(".git").join("epicenter").join("scratch"),
        }
    }

    pub fn absolute(&self, path: &str) -> PathBuf {
        let mut absolute = self.root.clone();
        absolute.extend(path.split('/'));
        absolute
    }

    /// Verify each component's literal spelling and that nothing on the way is
    /// a symbolic link, so a case-insensitive filesystem cannot alias another
    /// name and a link cannot escape the folder.
    fn verify_literal(&self, path: &str) -> Result<Kind, FileError> {
        let parts: Vec<&str> = path.split('/').collect();
        let mut directory = self.root.clone();
        for (index, name) in parts.iter().enumerate() {
            let entries = match fs::read_dir(&directory) {
                Ok(entries) => entries,
                Err(cause) if cause.kind() == ErrorKind::NotFound => return Ok(Kind::Absent),
                Err(cause) if cause.kind() == ErrorKind::NotADirectory => {
                    return Err(FileError::NotADirectory {
                        path: parts[..index].join("/"),
                    })
                }
                Err(cause) => return Err(io(path, "list the directory of", &cause)),
            };
            let mut spelled = false;
            for entry in entries {
                let entry = entry.map_err(|cause| io(path, "list the directory of", &cause))?;
                if entry.file_name().to_str() == Some(name) {
                    spelled = true;
                    break;
                }
            }
            if !spelled {
                return Ok(Kind::Absent);
            }
            let next = directory.join(name);
            let stats = match fs::symlink_metadata(&next) {
                Ok(stats) => stats,
                Err(cause) if cause.kind() == ErrorKind::NotFound => return Ok(Kind::Absent),
                Err(cause) => return Err(io(path, "inspect", &cause)),
            };
            let kind = stats.file_type();
            if kind.is_symlink() {
                return Err(FileError::InvalidPath {
                    path: path.to_string(),
                    reason: "the path passes through a symbolic link".to_string(),
                });
            }
            if index == parts.len() - 1 {
                if kind.is_dir() {
                    return Ok(Kind::Directory);
                }
                if kind.is_file() {
                    return Ok(Kind::File);
                }
                // A device, socket, or pipe: reading it could block forever.
                return Err(FileError::InvalidPath {
                    path: path.to_string(),
                    reason: "the path is not a regular file".to_string(),
                });
            }
            if !kind.is_dir() {
                return Err(FileError::NotADirectory {
                    path: parts[..=index].join("/"),
                });
            }
            directory = next;
        }
        Ok(Kind::Absent)
    }

    fn read_current(&self, path: &str) -> Result<Option<FileRead>, FileError> {
        match self.verify_literal(path)? {
            Kind::Absent => return Ok(None),
            Kind::Directory => {
                return Err(FileError::NotAFile {
                    path: path.to_string(),
                })
            }
            Kind::File => {}
        }
        match fs::read(self.absolute(path)) {
            Ok(bytes) => {
                let version = FileVersion::of(&bytes);
                Ok(Some(FileRead { bytes, version }))
            }
            Err(cause) if cause.kind() == ErrorKind::NotFound => Ok(None),
            Err(cause) => Err(io(path, "read", &cause)),
        }
    }

    fn current_version(&self, path: &str) -> Result<Option<FileVersion>, FileError> {
        Ok(self.read_current(path)?.map(|read| read.version))
    }

    fn ensure_parent(&self, path: &str) -> Result<(), FileError> {
        for parent in ancestors(path) {
            match self.verify_literal(parent)? {
                Kind::Directory => {}
                Kind::File => {
                    return Err(FileError::NotADirectory {
                        path: parent.to_string(),
                    })
                }
                Kind::Absent => match fs::create_dir(self.absolute(parent)) {
                    Ok(()) => {}
                    Err(cause) if cause.kind() == ErrorKind::AlreadyExists => {}
                    Err(cause) => return Err(io(parent, "create", &cause)),
                },
            }
        }
        Ok(())
    }

    fn scratch_file(&self, bytes: &[u8]) -> io::Result<PathBuf> {
        fs::create_dir_all(&self.scratch)?;
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0);
        let file = self.scratch.join(format!(
            "{nanos:x}-{}-{}",
            std::process::id(),
            SCRATCH_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let mut handle = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&file)?;
        if let Err(cause) = handle.write_all(bytes) {
            let _ = fs::remove_file(&file);
            return Err(cause);
        }
        Ok(file)
    }

    fn conflict(
        &self,
        path: &str,
        expected: &FileExpectation,
        actual: Option<FileVersion>,
    ) -> FileError {
        FileError::Conflict {
            path: path.to_string(),
            expected: expected.clone(),
            actual,
        }
    }

    fn write(&self, path: &str, bytes: &[u8], expected: &FileExpectation) -> Result<(), FileError> {
        let found = self.current_version(path)?;
        if !expected.satisfied_by(found.as_ref()) {
            return Err(self.conflict(path, expected, found));
        }
        self.ensure_parent(path)?;
        let temporary = self
            .scratch_file(bytes)
            .map_err(|cause| io(path, "stage bytes for", &cause))?;
        let published = (|| {
            // Staging and parent creation took time. Check the version again so
            // the only unchecked window left is this read to the rename below.
            if let FileExpectation::Version { .. } = expected {
                let now = self.current_version(path)?;
                if !expected.satisfied_by(now.as_ref()) {
                    return Err(self.conflict(path, expected, now));
                }
            }
            if found.is_none() && *expected != FileExpectation::Any {
                // Exclusive creation: a link fails instead of replacing a newcomer.
                match fs::hard_link(&temporary, self.absolute(path)) {
                    Ok(()) => Ok(()),
                    Err(cause) if cause.kind() == ErrorKind::AlreadyExists => {
                        let now = self.current_version(path).ok().flatten();
                        Err(self.conflict(path, expected, now))
                    }
                    Err(cause) => Err(io(path, "create", &cause)),
                }
            } else {
                fs::rename(&temporary, self.absolute(path))
                    .map_err(|cause| io(path, "replace", &cause))
            }
        })();
        let _ = fs::remove_file(&temporary);
        published
    }

    fn remove(&self, path: &str, expected: &FileExpectation) -> Result<(), FileError> {
        let not_found = || FileError::NotFound {
            path: path.to_string(),
        };
        let found = self.current_version(path)?.ok_or_else(not_found)?;
        if !expected.satisfied_by(Some(&found)) {
            return Err(self.conflict(path, expected, Some(found)));
        }
        match fs::remove_file(self.absolute(path)) {
            Ok(()) => Ok(()),
            Err(cause) if cause.kind() == ErrorKind::NotFound => Err(not_found()),
            Err(cause) => Err(io(path, "remove", &cause)),
        }
    }

    /// A move is two filesystem steps. When the destination link lands but
    /// retiring the source fails, `landed` receives the destination write so
    /// the caller reports it instead of an ordinary error.
    fn rename(
        &self,
        from: &str,
        to: &str,
        expected: &FileExpectation,
        landed: &mut Vec<FileStep>,
    ) -> Result<(), FileError> {
        let found = self.current_version(from)?.ok_or(FileError::NotFound {
            path: from.to_string(),
        })?;
        if !expected.satisfied_by(Some(&found)) {
            return Err(self.conflict(from, expected, Some(found)));
        }
        match self.verify_literal(to)? {
            Kind::Directory => {
                return Err(FileError::NotAFile {
                    path: to.to_string(),
                })
            }
            Kind::File => {
                let now = self.current_version(to).ok().flatten();
                return Err(self.conflict(to, &FileExpectation::Absent, now));
            }
            Kind::Absent => {}
        }
        self.ensure_parent(to)?;
        if *expected != FileExpectation::Any {
            // The destination checks took time; the link must carry the bytes checked.
            let now = self.current_version(from)?;
            if !expected.satisfied_by(now.as_ref()) {
                return Err(self.conflict(from, expected, now));
            }
        }
        match fs::hard_link(self.absolute(from), self.absolute(to)) {
            Ok(()) => {}
            Err(cause) if cause.kind() == ErrorKind::AlreadyExists => {
                let now = self.current_version(to).ok().flatten();
                return Err(self.conflict(to, &FileExpectation::Absent, now));
            }
            Err(cause) => return Err(io(to, "move to", &cause)),
        }
        landed.push(FileStep::Write {
            path: to.to_string(),
        });
        // Both paths now hold the bytes; nothing is rolled back if this fails.
        fs::remove_file(self.absolute(from)).map_err(|cause| io(from, "retire", &cause))
    }

    fn step(&self, change: &FileChange, landed: &mut Vec<FileStep>) -> Result<(), FileError> {
        match change {
            FileChange::Write {
                path,
                bytes,
                expected,
            } => self.write(path, bytes, expected),
            FileChange::Remove { path, expected } => self.remove(path, expected),
            FileChange::Move { from, to, expected } => self.rename(from, to, expected, landed),
        }
    }

    /// Refuse a batch naming any unusable path before one step runs.
    pub fn validate(changes: &[FileChange]) -> Result<(), FileError> {
        for change in changes {
            for path in change.paths() {
                invalid(path)?;
            }
        }
        Ok(())
    }

    /// Apply ordered steps. The caller holds the owner's file gate, so the
    /// steps run with no other batch of this owner between them.
    pub fn apply(&self, changes: &[FileChange]) -> Result<(), ApplyError> {
        Self::validate(changes).map_err(|error| ApplyError::Refused { error })?;
        let mut applied: Vec<FileStep> = Vec::new();
        for (index, change) in changes.iter().enumerate() {
            let mut landed = Vec::new();
            match self.step(change, &mut landed) {
                Ok(()) => applied.push(change.step()),
                Err(error) => {
                    // A move whose destination landed failed at retiring its source.
                    let failed = match change {
                        FileChange::Move { from, .. } if !landed.is_empty() => {
                            FileStep::Remove { path: from.clone() }
                        }
                        other => other.step(),
                    };
                    applied.extend(landed);
                    if applied.is_empty() {
                        return Err(ApplyError::Refused { error });
                    }
                    return Err(ApplyError::Partial {
                        applied,
                        failed,
                        error,
                        not_attempted: changes[index + 1..].iter().map(FileChange::step).collect(),
                    });
                }
            }
        }
        Ok(())
    }

    pub fn list(&self) -> Result<FileListing, FileError> {
        let mut listing = FileListing::default();
        let mut pending = vec![(self.root.clone(), String::new())];
        while let Some((directory, prefix)) = pending.pop() {
            let enumerate = |cause: io::Error| io("", "enumerate", &cause);
            for entry in fs::read_dir(&directory).map_err(enumerate)? {
                let entry = entry.map_err(enumerate)?;
                let name = entry.file_name();
                // A name that is not UTF-8 has no folder path.
                let Some(name) = name.to_str() else { continue };
                if prefix.is_empty() && name == ".git" {
                    continue;
                }
                let path = format!("{prefix}{name}");
                let kind = entry.file_type().map_err(enumerate)?;
                if kind.is_dir() {
                    pending.push((entry.path(), format!("{path}/")));
                    listing.directories.push(path);
                } else if kind.is_file() {
                    let size = entry.metadata().map_err(enumerate)?.len();
                    listing.files.push(ListedFile { path, size });
                }
            }
        }
        listing.files.sort_by(|a, b| a.path.cmp(&b.path));
        listing.directories.sort();
        Ok(listing)
    }

    pub fn children(&self, directory: &str) -> Result<Children, FileError> {
        if !directory.is_empty() {
            invalid(directory)?;
            match self.verify_literal(directory)? {
                Kind::Directory => {}
                Kind::Absent => {
                    return Err(FileError::NotFound {
                        path: directory.to_string(),
                    })
                }
                Kind::File => {
                    return Err(FileError::NotADirectory {
                        path: directory.to_string(),
                    })
                }
            }
        }
        let target = if directory.is_empty() {
            self.root.clone()
        } else {
            self.absolute(directory)
        };
        let list = |cause: io::Error| io(directory, "list", &cause);
        let mut children = Children::default();
        for entry in fs::read_dir(target).map_err(list)? {
            let entry = entry.map_err(list)?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if directory.is_empty() && name == ".git" {
                continue;
            }
            let kind = entry.file_type().map_err(list)?;
            if kind.is_file() {
                children.files.push(name.to_string());
            } else if kind.is_dir() {
                children.directories.push(name.to_string());
            }
        }
        children.files.sort();
        children.directories.sort();
        Ok(children)
    }

    pub fn read(&self, path: &str) -> Result<FileRead, FileError> {
        invalid(path)?;
        self.read_current(path)?.ok_or(FileError::NotFound {
            path: path.to_string(),
        })
    }

    pub fn mkdir(&self, path: &str) -> Result<(), FileError> {
        invalid(path)?;
        self.ensure_parent(&format!("{path}/x"))
    }

    pub fn rmdir(&self, path: &str) -> Result<(), FileError> {
        invalid(path)?;
        match self.verify_literal(path)? {
            Kind::Directory => {}
            Kind::Absent => {
                return Err(FileError::NotFound {
                    path: path.to_string(),
                })
            }
            Kind::File => {
                return Err(FileError::NotADirectory {
                    path: path.to_string(),
                })
            }
        }
        match fs::remove_dir(self.absolute(path)) {
            Ok(()) => Ok(()),
            Err(cause)
                if matches!(
                    cause.kind(),
                    ErrorKind::DirectoryNotEmpty | ErrorKind::AlreadyExists
                ) =>
            {
                Err(FileError::DirectoryNotEmpty {
                    path: path.to_string(),
                })
            }
            Err(cause) => Err(io(path, "remove directory", &cause)),
        }
    }
}

/// Resolve the folder root once, refusing a path that is not a directory.
pub fn resolve_root(root: &Path) -> Result<PathBuf, String> {
    let resolved = fs::canonicalize(root).map_err(|cause| {
        format!(
            "The native folder root '{}' could not be resolved: {cause}",
            root.display()
        )
    })?;
    if !resolved.is_dir() {
        return Err(format!(
            "The native folder root '{}' is not a directory.",
            root.display()
        ));
    }
    Ok(resolved)
}

/// Refuse a root whose private Git state would send writes somewhere else:
/// `.git` as a symbolic link or a `gitdir:` file (a linked worktree or
/// submodule), and a linked `.git/epicenter` or scratch directory. Scratch
/// files are renamed into the folder, so they must live inside it.
///
/// This inspects the layout once, when the folder opens. It does not defend
/// against a program that swaps a link in afterward.
pub fn verify_layout(root: &Path) -> Result<(), String> {
    let mut current = root.to_path_buf();
    for (name, label) in [
        (".git", ".git"),
        ("epicenter", ".git/epicenter"),
        ("scratch", ".git/epicenter/scratch"),
    ] {
        current.push(name);
        let stats = match fs::symlink_metadata(&current) {
            Ok(stats) => stats,
            // Nothing below an absent directory exists yet; opening creates it.
            Err(cause) if cause.kind() == ErrorKind::NotFound => return Ok(()),
            Err(cause) => {
                return Err(format!(
                "The native folder '{}' cannot be opened: {label} could not be inspected: {cause}",
                root.display()
            ))
            }
        };
        let kind = stats.file_type();
        if kind.is_symlink() {
            return Err(format!(
                "The native folder '{}' cannot be opened: {label} is a symbolic link.",
                root.display()
            ));
        }
        if !kind.is_dir() {
            return Err(if name == ".git" {
                format!(
                    "The native folder '{}' cannot be opened: .git is a file that points at another Git directory.",
                    root.display()
                )
            } else {
                format!(
                    "The native folder '{}' cannot be opened: {label} is not a directory.",
                    root.display()
                )
            });
        }
    }
    Ok(())
}

/// Where the cross-process lock for a canonical root lives: a sibling, outside
/// the folder's files. The same file the Bun hosts lock (`root-lock.ts`).
pub fn lock_path(root: &Path) -> Result<PathBuf, String> {
    let (Some(parent), Some(name)) = (root.parent(), root.file_name()) else {
        return Err(format!(
            "The folder at {} has no parent directory to hold its lock.",
            root.display()
        ));
    };
    let mut file = std::ffi::OsString::from(".");
    file.push(name);
    file.push(".epicenter-lock");
    Ok(parent.join(file))
}

/// Refuse a lock path that is a symbolic link or anything other than a regular
/// file, before it is opened, so the lock is never taken on a database
/// somewhere else. Checked once; it does not defend against a later swap.
pub fn verify_lock_path(root: &Path) -> Result<PathBuf, String> {
    let path = lock_path(root)?;
    match fs::symlink_metadata(&path) {
        Err(cause) if cause.kind() == ErrorKind::NotFound => Ok(path),
        Err(cause) => Err(format!(
            "The folder at {} could not be locked: {} could not be inspected: {cause}",
            root.display(),
            path.display()
        )),
        Ok(stats) if stats.file_type().is_file() => Ok(path),
        Ok(stats) => Err(format!(
            "The folder at {} could not be locked: {} is {}. Remove it, then open the folder again.",
            root.display(),
            path.display(),
            if stats.file_type().is_symlink() {
                "a symbolic link"
            } else {
                "not a regular file"
            }
        )),
    }
}
