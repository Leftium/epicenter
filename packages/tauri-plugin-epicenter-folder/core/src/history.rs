//! What the folder owner reports about history.
//!
//! These are the native counterparts of the types in
//! `packages/app/src/files/git/history.ts`, and they are the wire contract:
//! the TypeScript bindings are generated from them. They carry object IDs,
//! paths, and reasons, never file bytes, so a status or commit response stays
//! small however much audio the folder holds.

use serde::Serialize;
use specta::Type;

use crate::files::{FileError, FileStep};
use crate::git::Remote;
use crate::messages::PathChange;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "name")]
pub enum GitError {
    /// The operation started and its outcome is unknown: it may have changed
    /// history. Inspect before trying again.
    Unconfirmed {
        operation: String,
        cause: String,
    },
    Failed {
        operation: String,
        cause: String,
    },
    Closed,
    /// The caller withdrew before the owner started the transport: nothing
    /// was sent or received for this request.
    Withdrawn,
    /// The caller has no session for this folder, or names another window's.
    Denied {
        reason: String,
    },
    NoRemote,
    InvalidMessage {
        reason: String,
    },
    NothingToCommit,
    /// Staged authoring requires `commitOnEdit: false`.
    AutomaticHistory,
    BranchMoved {
        expected: Option<String>,
        actual: Option<String>,
    },
}

impl GitError {
    pub fn failed(operation: &str, cause: impl Into<String>) -> Self {
        Self::Failed {
            operation: operation.to_string(),
            cause: cause.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum CommitOutcome {
    #[serde(rename_all = "camelCase")]
    Committed {
        oid: String,
        parent: Option<String>,
        message: String,
        changed_paths: u32,
        /// The branch moved, but the index could not be updated to match.
        index_warning: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Unchanged {
        head: Option<String>,
        /// Index entries could not be reset to the head; the next commit retries.
        index_warning: Option<String>,
    },
    /// The branch named something else when the candidate was published. The
    /// candidate stays unreachable; there is no retry.
    BranchMoved {
        candidate: String,
        expected: Option<String>,
        actual: Option<String>,
    },
    Blocked {
        reason: String,
    },
    Failed {
        error: String,
    },
    /// The commit started and its outcome is unknown; inspect history first.
    Unconfirmed {
        error: String,
    },
    Closed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum PushOutcome {
    Pushed {
        oid: String,
    },
    NoRemote,
    NothingToPush,
    /// Nothing was sent: the commit to push could not be determined.
    Skipped {
        reason: String,
    },
    Failed {
        oid: String,
        error: String,
    },
    /// The push started and its outcome is unknown.
    Unconfirmed {
        error: String,
    },
    Cancelled {
        oid: Option<String>,
    },
    Closed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct FetchOutcome {
    /// The remote branch head, or `null` when the remote has no such branch.
    pub oid: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum PullOutcome {
    UpToDate {
        head: Option<String>,
    },
    Ahead {
        head: String,
    },
    #[serde(rename_all = "camelCase")]
    FastForwarded {
        from: Option<String>,
        to: String,
        changed_paths: Vec<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "name")]
pub enum PullError {
    /// A failure every Git operation can report.
    Git {
        error: GitError,
    },
    NoFetchedHead,
    /// The folder cannot be updated now.
    Blocked {
        reason: String,
    },
    Diverged {
        head: String,
        fetched: String,
    },
    Dirty {
        paths: Vec<String>,
    },
    StagedChanges,
    /// The update would overwrite ignored or untracked files.
    Collision {
        paths: Vec<String>,
    },
    Unrepresentable {
        paths: Vec<String>,
        reason: String,
    },
    /// A file changed before the update could be written; nothing was written.
    Refused {
        error: FileError,
    },
    /// The update stopped after some file steps; the branch did not move.
    Partial {
        applied: Vec<FileStep>,
        error: FileError,
    },
    #[serde(rename_all = "camelCase")]
    BranchMoved {
        actual: Option<String>,
        files_applied: bool,
    },
    /// Files were updated, but the index could not be; the branch did not move.
    IndexFailed {
        error: String,
    },
}

impl From<GitError> for PullError {
    fn from(error: GitError) -> Self {
        Self::Git { error }
    }
}

/// A settled attempt recorded in the snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Settled<T, E> {
    Ok { value: T },
    Err { error: E },
}

impl<T, E> From<Result<T, E>> for Settled<T, E> {
    fn from(result: Result<T, E>) -> Self {
        match result {
            Ok(value) => Self::Ok { value },
            Err(error) => Self::Err { error },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Observation<T> {
    Unknown {
        error: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Observed {
        value: T,
        /// Milliseconds since the Unix epoch.
        checked_at: u64,
        /// A known change happened after this observation was captured.
        stale: bool,
        /// The latest attempt to refresh failed; `value` is the prior observation.
        error: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct FilesObservation {
    pub head: Option<String>,
    /// Portable files that differ from the committed tree.
    pub changes: Vec<PathChange>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct SyncObservation {
    pub head: Option<String>,
    /// The remote branch head as last recorded by a fetch or push.
    pub remote: Option<String>,
    pub ahead: u32,
    pub behind: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Type)]
pub struct Activity {
    pub active: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Type)]
pub struct Activities {
    pub scan: Activity,
    pub commit: Activity,
    pub push: Activity,
    pub fetch: Activity,
    pub pull: Activity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct Attempt<T> {
    pub result: T,
    /// Milliseconds since the Unix epoch.
    pub at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitSnapshot {
    pub branch: String,
    pub remote: Option<Remote>,
    pub commit_on_edit: bool,
    pub files: Observation<FilesObservation>,
    pub sync: Observation<SyncObservation>,
    pub activity: Activities,
    pub last_commit: Option<Attempt<CommitOutcome>>,
    pub last_push: Option<Attempt<PushOutcome>>,
    pub last_fetch: Option<Attempt<Settled<FetchOutcome, GitError>>>,
    pub last_pull: Option<Attempt<Settled<PullOutcome, PullError>>>,
    pub closed: bool,
}

/// What every listener hears from the owner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OwnerEvent {
    /// The shared Git snapshot changed. `sequence` only grows, so a listener
    /// can drop a delivery that arrives out of order.
    Snapshot {
        sequence: u64,
        snapshot: GitSnapshot,
    },
    /// Files changed, through this owner or outside it. `revision` only grows.
    FilesChanged { revision: u64, paths: Vec<String> },
}
