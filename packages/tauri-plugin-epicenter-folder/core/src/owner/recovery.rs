//! Finishing an incoming update from its record (ADR-0474).
//!
//! A fast-forward and an explicit recovery run the same roll-forward, under
//! the file gate and the Git lock. It reads the branch, the index, and every
//! path the update changes, and goes on only if each holds the update's
//! before or its after state:
//!
//! - The branch names the target: publication finished before the record was
//!   cleared. The record goes; no file is replayed, so later edits stay.
//! - The branch names anything but the update's before commit: someone else
//!   moved it. Nothing is written.
//! - The index holds staged changes the update does not make, or an entry in
//!   neither state: nothing is written.
//! - A path holds bytes in neither state, is missing, is an unexplained
//!   directory, or has a file or directory in the way of a write: nothing is
//!   written, and the paths are named. An empty file where the update adds a
//!   nonempty one is in neither state; it is not absence.
//!
//! Then removals, the directories they emptied where a file must go, and
//! writes, each conditional on the before state it was found in; then every
//! path is checked for its after state; then the index through Git's lock
//! protocol; then the branch by compare-and-swap. Only a verified finish
//! clears the record, and the record goes before its pins. Any step whose
//! outcome is unknown, or that stops partway, keeps the record. Nothing is
//! ever rolled back, and nothing here runs unless a pull or a recovery was
//! asked for.
//!
//! What another program does between these checks and the writes stays best
//! effort, as for every save.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::Ordering;
use std::sync::MutexGuard;

use super::{lock, Inner};
use crate::files::{sha256, ApplyError, Entry, FileChange, FileError, FileStep};
use crate::git::Cas;
use crate::history::{GitError, PendingIncoming, PullError, PullOutcome, RecoverOutcome};
use crate::incoming::{self, Found, Plan, Record};
use crate::paths::{ancestors, path_problem};

/// The record and the index, as a step that may or may not have been
/// written names them.
pub(super) const RECORD_LABEL: &str = ".git/epicenter/incoming.json";
const INDEX_LABEL: &str = ".git/index";

/// An update stopped at a test boundary, as a process that stopped there
/// would leave it: whatever happened after it is unknown.
pub(super) fn stopped_at(boundary: &str, applied: Vec<FileStep>) -> PullError {
    PullError::Unconfirmed {
        applied,
        uncertain: vec![boundary.to_string()],
        error: format!("the update stopped at {boundary}"),
    }
}

/// Which recorded state one changed path holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Side {
    Before,
    After,
}

struct Survey {
    entries: BTreeMap<String, Entry>,
    sides: BTreeMap<String, Side>,
    /// Directories where the update writes a file, emptied by its removals.
    emptied: Vec<String>,
}

/// What found the folder in neither state.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Kind {
    /// A changed path holds neither state.
    Files,
    /// Something is in the way of a path the update writes.
    Collision,
    /// The index holds changes the update does not make.
    Index,
    /// The branch names neither commit, or HEAD is not on it.
    Branch(Option<String>),
    /// The update's own commit cannot be written as plain files.
    Commit,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Refusal {
    kind: Kind,
    paths: Vec<String>,
    reason: String,
}

/// Why one attempt stopped.
enum Stop {
    Refused(Refusal),
    /// A file step failed and wrote nothing itself.
    File(FileError),
    IndexFailed(String),
    BranchMoved(Option<String>),
    Unconfirmed {
        uncertain: Vec<String>,
        error: String,
    },
}

/// How far one attempt got. `wrote` is every file step this attempt took,
/// and nothing else: a path found already at its after state is not in it.
enum Rolled {
    /// The branch already named the target; the record was cleared.
    Cleared,
    /// The branch moved to the target. The record was removed if the move
    /// was read back; otherwise it stays for a recovery to verify.
    Completed {
        wrote: Vec<FileStep>,
    },
    Stopped {
        wrote: Vec<FileStep>,
        stop: Stop,
    },
}

fn stop(wrote: Vec<FileStep>, stop: Stop) -> Rolled {
    Rolled::Stopped { wrote, stop }
}

fn interrupted(wrote: Vec<FileStep>, boundary: &str) -> Rolled {
    stop(
        wrote,
        Stop::Unconfirmed {
            uncertain: vec![boundary.to_string()],
            error: format!("the update stopped at {boundary}"),
        },
    )
}

fn step_paths(steps: &[FileStep]) -> Vec<String> {
    steps
        .iter()
        .flat_map(FileStep::paths)
        .collect::<BTreeSet<&str>>()
        .into_iter()
        .map(str::to_string)
        .collect()
}

fn file_error_path(error: &FileError) -> Option<String> {
    match error {
        FileError::InvalidPath { path, .. }
        | FileError::NotFound { path }
        | FileError::Exists { path }
        | FileError::Conflict { path, .. }
        | FileError::NotAFile { path }
        | FileError::NotADirectory { path }
        | FileError::DirectoryNotEmpty { path }
        | FileError::Io { path, .. }
        | FileError::Unconfirmed { path, .. } => Some(path.clone()),
        FileError::Closed | FileError::Denied { .. } => None,
    }
}

impl Inner {
    /// Read the incoming record, and remember what it said for the snapshot.
    pub(super) fn read_pending(&self) -> Found {
        let found = incoming::read(self.git.gitdir());
        lock(&self.state).pending_incoming = found.pending();
        found
    }

    /// A test may stop an incoming update at a named boundary: `record`,
    /// `recorded`, `file:<path>`, `index`, `branch`, `clear`, or `unpin`.
    #[cfg(test)]
    pub(super) fn boundary(&self, name: &str) -> bool {
        let hook = lock(&self.hooks).incoming_boundary.clone();
        hook.is_some_and(|hook| hook(name))
    }

    #[cfg(not(test))]
    pub(super) fn boundary(&self, _name: &str) -> bool {
        false
    }

    /// After a recovery: it looked only at the paths the update changes, and
    /// other files may hold edits made while it was pending. The last
    /// observation is marked stale and a real status follows; nothing is
    /// assumed clean.
    fn observe_again(&self) {
        self.mark_files_stale();
        self.scan.request();
    }

    /// Remove the record and pins of an update that wrote nothing.
    fn withdraw(&self, record: &Record) {
        if incoming::clear(self.git.gitdir()).is_ok() {
            let _ = incoming::unpin(&self.git, record);
        }
    }

    /// The rest of a fast-forward whose record is in place. A first look
    /// that finds something in neither state, before anything was written,
    /// withdraws the update whole, as if it had not been admitted.
    pub(super) fn finish_pull(
        &self,
        record: &Record,
        head: Option<String>,
        captured_at: u64,
    ) -> Result<Result<PullOutcome, PullError>, String> {
        let rolled = match self.roll_forward(record) {
            Ok(rolled) => rolled,
            Err(cause) => {
                self.withdraw(record);
                return Err(cause);
            }
        };
        Ok(match rolled {
            Rolled::Cleared => Ok(PullOutcome::UpToDate {
                head: Some(record.next_head.clone()),
            }),
            Rolled::Completed { wrote } => {
                self.observe_committed(captured_at, Some(&record.next_head));
                let paths = step_paths(&wrote);
                self.files_changed(paths.clone());
                Ok(PullOutcome::FastForwarded {
                    from: head,
                    to: record.next_head.clone(),
                    changed_paths: paths,
                })
            }
            Rolled::Stopped {
                wrote,
                stop: Stop::Refused(refusal),
            } if wrote.is_empty() => {
                self.withdraw(record);
                Err(match refusal.kind {
                    Kind::Files => PullError::Dirty {
                        paths: refusal.paths,
                    },
                    Kind::Collision => PullError::Collision {
                        paths: refusal.paths,
                    },
                    Kind::Index => PullError::StagedChanges,
                    Kind::Branch(actual) => PullError::BranchMoved {
                        actual,
                        files_applied: false,
                    },
                    Kind::Commit => PullError::Unrepresentable {
                        paths: refusal.paths,
                        reason: refusal.reason,
                    },
                })
            }
            Rolled::Stopped {
                wrote,
                stop: Stop::File(error),
            } if wrote.is_empty() => {
                self.withdraw(record);
                Err(PullError::Refused { error })
            }
            Rolled::Stopped { wrote, stop } => Err(self.stopped_partway(wrote, stop)),
        })
    }

    /// The error for an update that stopped once it may have changed
    /// something. Its record stays; listeners hear what it wrote.
    fn stopped_partway(&self, wrote: Vec<FileStep>, stop: Stop) -> PullError {
        if !wrote.is_empty() {
            self.landed(&wrote);
        }
        match stop {
            Stop::Refused(refusal) => PullError::Partial {
                applied: wrote,
                error: FileError::Io {
                    path: refusal.paths.first().cloned().unwrap_or_default(),
                    operation: "finish the incoming update at".to_string(),
                    cause: refusal.reason,
                },
            },
            Stop::File(error) => PullError::Partial {
                applied: wrote,
                error,
            },
            Stop::IndexFailed(error) => PullError::IndexFailed { error },
            Stop::BranchMoved(actual) => PullError::BranchMoved {
                actual,
                files_applied: true,
            },
            Stop::Unconfirmed { uncertain, error } => PullError::Unconfirmed {
                applied: wrote,
                uncertain,
                error,
            },
        }
    }

    pub(super) fn run_recovery(&self) -> Result<RecoverOutcome, PullError> {
        let (files, git) = self.enter_both();
        // Shutdown began while this waited: nothing ran.
        if self.closing.load(Ordering::SeqCst) {
            return Err(GitError::Closed.into());
        }
        let result = self.recover(files, git);
        self.read_pending();
        self.refresh_sync();
        self.emit();
        result
    }

    /// The file gate and the Git lock are held until the record is settled
    /// one way or the other.
    fn recover(
        &self,
        _files: MutexGuard<'_, ()>,
        _git: MutexGuard<'_, ()>,
    ) -> Result<RecoverOutcome, PullError> {
        let record = match self.read_pending() {
            Found::None => return Ok(RecoverOutcome::None),
            Found::Unreadable(reason) => {
                return Err(PullError::RecoveryRefused {
                    pending: PendingIncoming::Unreadable {
                        reason: reason.clone(),
                    },
                    paths: Vec::new(),
                    reason,
                })
            }
            Found::Recorded(record) => record,
        };
        let pending = record.pending();
        let refuse = |paths: Vec<String>, reason: String| PullError::RecoveryRefused {
            pending: pending.clone(),
            paths,
            reason,
        };
        let failed = |cause: String| PullError::from(GitError::failed("recover", cause));
        if record.branch != self.git.branch {
            return Err(refuse(
                Vec::new(),
                format!(
                    "the record is for the branch {}, and this folder records {}",
                    record.branch, self.git.branch
                ),
            ));
        }
        for commit in record.expected_head.iter().chain([&record.next_head]) {
            if !self.git.has_commit(commit).map_err(failed)? {
                return Err(refuse(
                    Vec::new(),
                    format!("the commit {commit} the update names is missing"),
                ));
            }
        }
        match self.roll_forward(&record).map_err(failed)? {
            Rolled::Cleared => {
                self.observe_again();
                Ok(RecoverOutcome::Cleared { pending })
            }
            Rolled::Completed { wrote } => {
                let paths = step_paths(&wrote);
                if !wrote.is_empty() {
                    self.edited(&wrote);
                }
                self.observe_again();
                Ok(RecoverOutcome::Completed {
                    pending,
                    changed_paths: paths,
                })
            }
            Rolled::Stopped {
                wrote,
                stop: Stop::Refused(refusal),
            } if wrote.is_empty() => Err(refuse(refusal.paths, refusal.reason)),
            Rolled::Stopped {
                wrote,
                stop: Stop::File(error),
            } if wrote.is_empty() => Err(refuse(
                file_error_path(&error).into_iter().collect(),
                format!("{error:?}"),
            )),
            Rolled::Stopped { wrote, stop } => Err(self.stopped_partway(wrote, stop)),
        }
    }

    /// Roll `record` forward from whatever the folder holds now. The caller
    /// holds the file gate and the Git lock. The outer error is a failure
    /// before this attempt wrote anything.
    fn roll_forward(&self, record: &Record) -> Result<Rolled, String> {
        let refused = |kind: Kind, paths: Vec<String>, reason: String| {
            Ok(stop(
                Vec::new(),
                Stop::Refused(Refusal {
                    kind,
                    paths,
                    reason,
                }),
            ))
        };

        // The branch: already the target, still the start, or someone else's.
        let head = self.git.read_branch()?;
        if head.as_deref() == Some(record.next_head.as_str()) {
            if self.boundary("clear") {
                return Ok(interrupted(Vec::new(), "clear"));
            }
            incoming::clear(self.git.gitdir())?;
            if !self.boundary("unpin") {
                let _ = incoming::unpin(&self.git, record);
            }
            return Ok(Rolled::Cleared);
        }
        if head != record.expected_head {
            return refused(
                Kind::Branch(head.clone()),
                Vec::new(),
                format!(
                    "the branch {} names {}, which is neither the update's before nor its after commit",
                    self.git.branch,
                    head.as_deref().unwrap_or("no commit")
                ),
            );
        }
        if let Some(reason) = self.git.blocked()? {
            return refused(Kind::Branch(head), Vec::new(), reason);
        }

        let plan = Plan::derive(&self.git, record)?;
        let unrepresentable: Vec<String> = plan
            .after
            .iter()
            .filter(|(path, (mode, _))| mode != "100644" || path_problem(path).is_some())
            .map(|(path, _)| path.clone())
            .collect();
        if !unrepresentable.is_empty() {
            return refused(
                Kind::Commit,
                unrepresentable,
                "the update's commit holds paths or modes that are not plain folder files"
                    .to_string(),
            );
        }

        // The index: each changed path at its before or its after entry, and
        // nothing else staged.
        let index = match self.git.index_entries() {
            Ok(index) => index,
            Err(cause) => {
                return refused(
                    Kind::Index,
                    vec![INDEX_LABEL.to_string()],
                    format!("the index cannot be read: {cause}"),
                )
            }
        };
        let staged = match self.git.staged_against(record.expected_head.as_deref()) {
            Ok(staged) => staged,
            Err(cause) => {
                return refused(
                    Kind::Index,
                    vec![INDEX_LABEL.to_string()],
                    format!("the index cannot be compared with the branch: {cause}"),
                )
            }
        };
        let affected: BTreeSet<&str> = plan.affected.iter().map(String::as_str).collect();
        let foreign: Vec<String> = staged
            .into_iter()
            .filter(|path| !affected.contains(path.as_str()))
            .collect();
        if !foreign.is_empty() {
            return refused(
                Kind::Index,
                foreign,
                "the index has staged changes the update does not make".to_string(),
            );
        }
        let mixed: Vec<String> = plan
            .affected
            .iter()
            .filter(|path| {
                let entry = index.get(*path);
                entry != plan.before.get(*path) && entry != plan.after.get(*path)
            })
            .cloned()
            .collect();
        if !mixed.is_empty() {
            return refused(
                Kind::Index,
                mixed,
                "the index holds neither the update's before nor its after entry".to_string(),
            );
        }
        let index_done = plan
            .affected
            .iter()
            .all(|path| index.get(path) == plan.after.get(path));

        // The files.
        let survey = match self.survey(&plan)? {
            Ok(survey) => survey,
            Err(refusal) => return Ok(stop(Vec::new(), Stop::Refused(refusal))),
        };
        let mut wrote: Vec<FileStep> = Vec::new();

        // Removals first, so a file can become a directory and back.
        for path in &plan.affected {
            if survey.sides[path] != Side::Before
                || plan.after.contains_key(path)
                || survey.entries[path] != Entry::File
            {
                continue;
            }
            let label = format!("file:{path}");
            if self.boundary(&label) {
                return Ok(interrupted(wrote, &label));
            }
            let expected = match self.git.read_blob(&plan.before[path].1) {
                Ok(bytes) => sha256(&bytes),
                Err(cause) => return Ok(stop(wrote, Stop::File(unreadable(path, cause)))),
            };
            let change = FileChange::Remove {
                path: path.clone(),
                expected_sha256: Some(expected),
            };
            if let Err(stopped) = self.publish_step(&change, &mut wrote) {
                return Ok(stop(wrote, stopped));
            }
        }
        // Directories the removals emptied, where a file must go. Only Git's
        // directories are removed, deepest first; anything that appeared in
        // them since the survey stops the update.
        for path in &survey.emptied {
            let label = format!("prune:{path}");
            if self.boundary(&label) {
                return Ok(interrupted(wrote, &label));
            }
            let (others, directories) = match self.files.beneath(path) {
                Ok(listed) => listed,
                Err(error) => return Ok(stop(wrote, Stop::File(error))),
            };
            if let Some(other) = others.first() {
                let error = FileError::DirectoryNotEmpty {
                    path: other.clone(),
                };
                return Ok(stop(wrote, Stop::File(error)));
            }
            if let Some(foreign) = directories
                .iter()
                .find(|directory| !Plan::holds_beneath(&plan.before, directory.as_str()))
            {
                let error = FileError::Io {
                    path: foreign.clone(),
                    operation: "remove the directory".to_string(),
                    cause: "it is not one the update's removals emptied".to_string(),
                };
                return Ok(stop(wrote, Stop::File(error)));
            }
            for directory in directories.iter().chain([path]) {
                if let Err(error) = self.files.rmdir(directory) {
                    return Ok(stop(wrote, Stop::File(error)));
                }
            }
        }
        // Writes, each conditional on the before state it was found in.
        for path in &plan.affected {
            let Some((_, after)) = plan.after.get(path) else {
                continue;
            };
            if survey.sides[path] != Side::Before {
                continue;
            }
            let label = format!("file:{path}");
            if self.boundary(&label) {
                return Ok(interrupted(wrote, &label));
            }
            let bytes = match self.git.read_blob(after) {
                Ok(bytes) => bytes,
                Err(cause) => return Ok(stop(wrote, Stop::File(unreadable(path, cause)))),
            };
            let change = match (plan.before.get(path), &survey.entries[path]) {
                (Some((_, before)), Entry::File) => match self.git.read_blob(before) {
                    Ok(previous) => FileChange::Replace {
                        path: path.clone(),
                        bytes,
                        expected_sha256: Some(sha256(&previous)),
                    },
                    Err(cause) => return Ok(stop(wrote, Stop::File(unreadable(path, cause)))),
                },
                _ => FileChange::Create {
                    path: path.clone(),
                    bytes,
                },
            };
            if let Err(stopped) = self.publish_step(&change, &mut wrote) {
                return Ok(stop(wrote, stopped));
            }
        }
        // Every changed path must now hold its after state.
        match self.survey(&plan) {
            Ok(Ok(now)) => {
                let behind: Vec<String> = plan
                    .affected
                    .iter()
                    .filter(|path| now.sides[*path] != Side::After)
                    .cloned()
                    .collect();
                if !behind.is_empty() {
                    let refusal = Refusal {
                        kind: Kind::Files,
                        reason: "the path changed while the update was writing".to_string(),
                        paths: behind,
                    };
                    return Ok(stop(wrote, Stop::Refused(refusal)));
                }
            }
            Ok(Err(refusal)) => return Ok(stop(wrote, Stop::Refused(refusal))),
            Err(error) => {
                let uncertain = plan.affected.clone();
                return Ok(stop(wrote, Stop::Unconfirmed { uncertain, error }));
            }
        }

        // The index, through Git's lock protocol.
        if !index_done {
            if self.boundary("index") {
                return Ok(interrupted(wrote, "index"));
            }
            if let Err(error) = self.git.sync_index(&record.next_head, &plan.affected) {
                return Ok(stop(wrote, Stop::IndexFailed(error)));
            }
        }
        match self.git.index_entries() {
            Ok(index)
                if plan
                    .affected
                    .iter()
                    .all(|path| index.get(path) == plan.after.get(path)) => {}
            Ok(_) => {
                let error = "the index does not hold the update's entries after they were written";
                return Ok(stop(wrote, Stop::IndexFailed(error.to_string())));
            }
            Err(error) => {
                let uncertain = vec![INDEX_LABEL.to_string()];
                return Ok(stop(wrote, Stop::Unconfirmed { uncertain, error }));
            }
        }

        // The branch, by compare-and-swap against the head it was admitted over.
        if self.boundary("branch") {
            return Ok(interrupted(wrote, "branch"));
        }
        let branch = vec![format!(".git/refs/heads/{}", self.git.branch)];
        let target = Some(record.next_head.as_str());
        match self.git.move_branch(
            record.expected_head.as_deref(),
            &record.next_head,
            "epicenter: incoming",
        ) {
            Ok(Cas::Moved) => {}
            Ok(Cas::Lost { actual }) if actual.as_deref() == target => {}
            Ok(Cas::Lost { actual }) => return Ok(stop(wrote, Stop::BranchMoved(actual))),
            Err(error) => {
                let uncertain = branch;
                return Ok(stop(wrote, Stop::Unconfirmed { uncertain, error }));
            }
        }
        match self.git.read_branch() {
            Ok(actual) if actual.as_deref() == target => {}
            Ok(actual) => return Ok(stop(wrote, Stop::BranchMoved(actual))),
            // The compare-and-swap replied that the branch moved; only the
            // reread failed. The update is published, but not verified, so
            // its record stays for an explicit recovery to verify and clear.
            Err(_) => return Ok(Rolled::Completed { wrote }),
        }

        // Verified complete. The record goes before its pins, so an
        // interruption between them leaves pins the next admission prunes,
        // never a record without its commits.
        if self.boundary("clear") {
            return Ok(interrupted(wrote, "clear"));
        }
        if incoming::clear(self.git.gitdir()).is_ok() && !self.boundary("unpin") {
            let _ = incoming::unpin(&self.git, record);
        }
        Ok(Rolled::Completed { wrote })
    }

    /// Publish one step. A refusal or failure wrote nothing of it.
    fn publish_step(&self, change: &FileChange, wrote: &mut Vec<FileStep>) -> Result<(), Stop> {
        match self.publish(std::slice::from_ref(change)) {
            Ok(()) => {
                wrote.push(change.step());
                Ok(())
            }
            Err(ApplyError::Refused { error }) | Err(ApplyError::Partial { error, .. }) => {
                Err(Stop::File(error))
            }
            Err(ApplyError::Unconfirmed { path, cause, .. }) => Err(Stop::Unconfirmed {
                uncertain: vec![path],
                error: cause,
            }),
        }
    }

    /// Where each changed path stands now, and which directories removals
    /// must empty before a file can be written where they are. Looking
    /// writes nothing.
    fn survey(&self, plan: &Plan) -> Result<Result<Survey, Refusal>, String> {
        let describe = |error: FileError| format!("{error:?}");
        let mut entries: BTreeMap<String, Entry> = BTreeMap::new();
        for path in &plan.affected {
            entries.insert(path.clone(), self.files.entry(path).map_err(describe)?);
        }
        let present: Vec<String> = entries
            .iter()
            .filter(|(_, entry)| **entry == Entry::File)
            .map(|(path, _)| path.clone())
            .collect();
        let hashed = self.git.hash_paths(&present)?;
        let oids: BTreeMap<&String, &String> = present.iter().zip(hashed.iter()).collect();

        let mut sides: BTreeMap<String, Side> = BTreeMap::new();
        let mut third: Vec<(String, String)> = Vec::new();
        for path in &plan.affected {
            let before = plan.before.get(path).map(|(_, blob)| blob);
            let after = plan.after.get(path).map(|(_, blob)| blob);
            let side = match &entries[path] {
                Entry::File => {
                    let oid = oids.get(path).copied();
                    if before.is_some() && before == oid {
                        Ok(Side::Before)
                    } else if after.is_some() && after == oid {
                        Ok(Side::After)
                    } else {
                        Err("holds bytes in neither state".to_string())
                    }
                }
                Entry::Absent if before.is_none() => Ok(Side::Before),
                Entry::Absent if after.is_none() => Ok(Side::After),
                Entry::Absent => Err("is missing".to_string()),
                Entry::Directory if before.is_none() && Plan::holds_beneath(&plan.before, path) => {
                    Ok(Side::Before)
                }
                Entry::Directory if after.is_none() && Plan::holds_beneath(&plan.after, path) => {
                    Ok(Side::After)
                }
                Entry::Directory => Err("is a directory".to_string()),
                Entry::Other(reason) => Err(reason.clone()),
            };
            match side {
                Ok(side) => {
                    sides.insert(path.clone(), side);
                }
                Err(reason) => third.push((path.clone(), reason)),
            }
        }
        if let Some((path, reason)) = third.first() {
            return Ok(Err(Refusal {
                kind: Kind::Files,
                reason: format!("{path} {reason}"),
                paths: third.iter().map(|(path, _)| path.clone()).collect(),
            }));
        }

        // What a write needs out of its way: only a file the update removes
        // above it, or a directory the update's removals empty.
        let removed = |path: &str| {
            !plan.after.contains_key(path)
                && sides.get(path) == Some(&Side::Before)
                && entries.get(path) == Some(&Entry::File)
        };
        let mut collisions: Vec<(String, String)> = Vec::new();
        let mut emptied = Vec::new();
        for path in &plan.affected {
            if !plan.after.contains_key(path) || sides[path] != Side::Before {
                continue;
            }
            for ancestor in ancestors(path) {
                match self.files.entry(ancestor).map_err(describe)? {
                    Entry::Absent | Entry::Directory => {}
                    Entry::File if removed(ancestor) => {}
                    Entry::File => collisions
                        .push((path.clone(), format!("the file {ancestor} is in the way"))),
                    Entry::Other(reason) => collisions.push((path.clone(), reason)),
                }
            }
            // A directory where a file must go. The before tree says which
            // directories are Git's: one that held a before file is the
            // update's to empty and remove, whether its files are still
            // there or an earlier attempt already removed them. Any other
            // file or directory in it is someone else's.
            if entries[path] == Entry::Directory {
                let (others, directories) = self.files.beneath(path).map_err(describe)?;
                if let Some(other) = others.iter().find(|other| !removed(other.as_str())) {
                    collisions.push((path.clone(), format!("{other} is in the way")));
                } else if let Some(foreign) = directories
                    .iter()
                    .find(|directory| !Plan::holds_beneath(&plan.before, directory.as_str()))
                {
                    collisions.push((
                        path.clone(),
                        format!("the directory {foreign} is in the way"),
                    ));
                } else {
                    emptied.push(path.clone());
                }
            }
        }
        if let Some((path, reason)) = collisions.first() {
            return Ok(Err(Refusal {
                kind: Kind::Collision,
                reason: format!("{path}: {reason}"),
                paths: collisions.iter().map(|(path, _)| path.clone()).collect(),
            }));
        }
        Ok(Ok(Survey {
            entries,
            sides,
            emptied,
        }))
    }
}

fn unreadable(path: &str, cause: String) -> FileError {
    FileError::Io {
        path: path.to_string(),
        operation: "read the incoming update's bytes for".to_string(),
        cause,
    }
}
