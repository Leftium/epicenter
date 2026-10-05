//! The record an incoming update keeps while it changes the folder
//! (ADR-0474).
//!
//! A fast-forward replaces authored files, then the index, then the branch.
//! A process can stop between any two of those, and the tree it leaves is
//! neither the old commit nor the new one. Before it changes anything, the
//! update writes one small record inside `.git/epicenter` naming exactly what
//! it is doing: an operation ID, the branch, the head it was admitted over
//! (`null` for an empty history), and the commit it moves to. Every path,
//! byte, and index entry the update touches is derived from the trees of
//! those two commits, so the record carries no file bytes. Private refs pin
//! both commits for as long as the record exists, so a later fetch that moves
//! the tracking ref, or a garbage collection, cannot take the target away.
//!
//! While the record exists, commits, staging, and new incoming updates are
//! refused; ordinary saves and fetches carry on. Opening the folder and
//! looking at its status report the record and never act on it. Only an
//! explicit recovery rolls the update forward, and only over paths that hold
//! exactly their before or their after state.
//!
//! A merge whose conflicts are left for a person records one more field, its
//! destination. Its `nextHead` is then a commit no ref but a pin ever names,
//! whose tree is the files a person resolves, markers included, and whose
//! parents are the head and the fetched commit. Publishing it never moves the
//! branch: the files and the index take that tree, each conflicted path's
//! index entry becomes its stages, and `ORIG_HEAD`, `MERGE_MSG`, and
//! `MERGE_HEAD` are written last. The fetched commit is pinned too.
//!
//! The record is written to a scratch name, flushed, and renamed into place,
//! so it is either absent or complete. It is removed before its pins, so an
//! interruption between the two leaves pins without a record, which the next
//! admission prunes, and never a record without its commits.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{Map, Value};
use specta::Type;

use crate::git::{Failure, Git};

/// Where the record lives, below the Git directory.
const RECORD: [&str; 2] = ["epicenter", "incoming.json"];
/// Every pin lives below this prefix, one directory per operation.
pub const PINS: &str = "refs/epicenter/incoming/";
const FIELDS: [&str; 5] = ["operationId", "branch", "expectedHead", "nextHead", "merge"];
const MERGE_FIELDS: [&str; 3] = ["incoming", "message", "unmerged"];
const STAGE_FIELDS: [&str; 4] = ["path", "base", "ours", "theirs"];

static OPERATIONS: AtomicU64 = AtomicU64::new(0);

/// A path a merge left for a person, with the blob each side had there:
/// Git's index stages 1 (`base`), 2 (`ours`), and 3 (`theirs`). A side
/// without the file has no stage. Every stage is a plain `100644` file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct UnmergedPath {
    pub path: String,
    pub base: Option<String>,
    pub ours: Option<String>,
    pub theirs: Option<String>,
}

/// Where an incoming merge with conflicts left in place ends: the branch
/// stays at the head it was admitted over, the files and the index take the
/// recorded commit's tree with each unmerged path's stages in place of its
/// entry, and Git's merge state names `incoming` with `message`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct UnfinishedMerge {
    /// The fetched commit: `MERGE_HEAD`, the merge commit's second parent.
    pub incoming: String,
    /// `MERGE_MSG`.
    pub message: String,
    pub unmerged: Vec<UnmergedPath>,
}

/// An incoming update whose authored changes may have begun.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Record {
    pub operation_id: String,
    pub branch: String,
    /// The branch head the update was admitted over; `None` for an empty history.
    pub expected_head: Option<String>,
    /// The commit the update moves the branch to, or for an unfinished merge
    /// the commit of the files it leaves, which the branch never names.
    pub next_head: String,
    /// Present when the update ends in an unfinished merge instead of a
    /// moved branch.
    pub merge: Option<UnfinishedMerge>,
}

/// What the folder's incoming record says, as the snapshot and refusals
/// report it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum PendingIncoming {
    /// An update that may have begun changing files. Recovery derives
    /// everything else from the trees of `expectedHead` and `nextHead`, and
    /// for an unfinished merge from `merge`.
    #[serde(rename_all = "camelCase")]
    Recorded {
        operation_id: String,
        branch: String,
        expected_head: Option<String>,
        next_head: String,
        merge: Option<UnfinishedMerge>,
    },
    /// The record holds something that is not a record. Nothing reads past
    /// it, acts on it, or removes it.
    Unreadable { reason: String },
}

/// What reading the record found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Found {
    None,
    Recorded(Record),
    Unreadable(String),
}

impl Found {
    pub fn pending(&self) -> Option<PendingIncoming> {
        match self {
            Found::None => None,
            Found::Recorded(record) => Some(record.pending()),
            Found::Unreadable(reason) => Some(PendingIncoming::Unreadable {
                reason: reason.clone(),
            }),
        }
    }
}

/// How writing the record ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Written {
    /// The record is in place and flushed.
    Durable,
    /// No record was put in place.
    Absent(String),
    /// The record is in place, but whether it would survive the machine
    /// stopping is not known.
    Unknown(String),
}

fn is_commit_id(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_operation_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte.is_ascii_lowercase() || byte == b'-')
}

impl Record {
    /// A record for a new update, under a fresh operation ID.
    pub fn new(branch: &str, expected_head: Option<String>, next_head: String) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0);
        Self {
            operation_id: format!(
                "{nanos:x}-{:x}-{}",
                std::process::id(),
                OPERATIONS.fetch_add(1, Ordering::SeqCst)
            ),
            branch: branch.to_string(),
            expected_head,
            next_head,
            merge: None,
        }
    }

    pub fn pending(&self) -> PendingIncoming {
        PendingIncoming::Recorded {
            operation_id: self.operation_id.clone(),
            branch: self.branch.clone(),
            expected_head: self.expected_head.clone(),
            next_head: self.next_head.clone(),
            merge: self.merge.clone(),
        }
    }

    /// The private ref that keeps `which` commit while the record exists.
    pub fn pin(&self, which: &str) -> String {
        format!("{PINS}{}/{which}", self.operation_id)
    }

    fn to_bytes(&self) -> Vec<u8> {
        let mut object = Map::new();
        object.insert("operationId".into(), Value::from(self.operation_id.clone()));
        object.insert("branch".into(), Value::from(self.branch.clone()));
        object.insert(
            "expectedHead".into(),
            self.expected_head.clone().map_or(Value::Null, Value::from),
        );
        object.insert("nextHead".into(), Value::from(self.next_head.clone()));
        if let Some(merge) = &self.merge {
            let oid = |value: &Option<String>| value.clone().map_or(Value::Null, Value::from);
            let unmerged: Vec<Value> = merge
                .unmerged
                .iter()
                .map(|path| {
                    let mut entry = Map::new();
                    entry.insert("path".into(), Value::from(path.path.clone()));
                    entry.insert("base".into(), oid(&path.base));
                    entry.insert("ours".into(), oid(&path.ours));
                    entry.insert("theirs".into(), oid(&path.theirs));
                    Value::Object(entry)
                })
                .collect();
            let mut destination = Map::new();
            destination.insert("incoming".into(), Value::from(merge.incoming.clone()));
            destination.insert("message".into(), Value::from(merge.message.clone()));
            destination.insert("unmerged".into(), Value::Array(unmerged));
            object.insert("merge".into(), Value::Object(destination));
        }
        let mut bytes =
            serde_json::to_vec_pretty(&Value::Object(object)).expect("a map of strings serializes");
        bytes.push(b'\n');
        bytes
    }

    /// Read a record, or say exactly why these bytes are not one.
    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        if bytes.is_empty() {
            return Err("the incoming record is empty".to_string());
        }
        let value: Value = serde_json::from_slice(bytes)
            .map_err(|cause| format!("the incoming record is not JSON: {cause}"))?;
        let Value::Object(object) = value else {
            return Err("the incoming record is not a JSON object".to_string());
        };
        if let Some(extra) = object.keys().find(|key| !FIELDS.contains(&key.as_str())) {
            return Err(format!(
                "the incoming record has the unexpected field {extra:?}"
            ));
        }
        let operation_id = text(&object, "operationId")?;
        if !is_operation_id(operation_id) {
            return Err(format!(
                "the incoming record's operationId {operation_id:?} is not an operation ID"
            ));
        }
        let branch = text(&object, "branch")?;
        if branch.is_empty() {
            return Err("the incoming record's branch is empty".to_string());
        }
        let next_head = text(&object, "nextHead")?;
        if !is_commit_id(next_head) {
            return Err(format!(
                "the incoming record's nextHead {next_head:?} is not a commit ID"
            ));
        }
        let expected_head = match object.get("expectedHead") {
            None => return Err("the incoming record has no expectedHead".to_string()),
            Some(Value::Null) => None,
            Some(Value::String(value)) if is_commit_id(value) => Some(value.clone()),
            Some(other) => {
                return Err(format!(
                    "the incoming record's expectedHead {other} is neither null nor a commit ID"
                ))
            }
        };
        let merge = match object.get("merge") {
            None => None,
            Some(value) => Some(parse_merge(value)?),
        };
        if merge.is_some() && expected_head.is_none() {
            return Err("the incoming record's merge has no expectedHead to stay at".to_string());
        }
        Ok(Self {
            operation_id: operation_id.to_string(),
            branch: branch.to_string(),
            expected_head,
            next_head: next_head.to_string(),
            merge,
        })
    }
}

/// The merge destination of a record, or why it is not one.
fn parse_merge(value: &Value) -> Result<UnfinishedMerge, String> {
    let Value::Object(object) = value else {
        return Err("the incoming record's merge is not a JSON object".to_string());
    };
    if let Some(extra) = object
        .keys()
        .find(|key| !MERGE_FIELDS.contains(&key.as_str()))
    {
        return Err(format!(
            "the incoming record's merge has the unexpected field {extra:?}"
        ));
    }
    let named = |name: &str| match object.get(name) {
        Some(Value::String(value)) => Ok(value.clone()),
        _ => Err(format!("the incoming record's merge has no string {name}")),
    };
    let incoming = named("incoming")?;
    if !is_commit_id(&incoming) {
        return Err(format!(
            "the incoming record's merge names {incoming:?}, which is not a commit ID"
        ));
    }
    let message = named("message")?;
    let Some(Value::Array(entries)) = object.get("unmerged") else {
        return Err("the incoming record's merge has no unmerged list".to_string());
    };
    let mut unmerged = Vec::new();
    for entry in entries {
        let Value::Object(entry) = entry else {
            return Err("an unmerged path of the incoming record is not an object".to_string());
        };
        if let Some(extra) = entry
            .keys()
            .find(|key| !STAGE_FIELDS.contains(&key.as_str()))
        {
            return Err(format!(
                "an unmerged path of the incoming record has the unexpected field {extra:?}"
            ));
        }
        let Some(Value::String(path)) = entry.get("path") else {
            return Err("an unmerged path of the incoming record has no path".to_string());
        };
        let stage = |name: &str| match entry.get(name) {
            Some(Value::Null) => Ok(None),
            Some(Value::String(oid)) if is_commit_id(oid) => Ok(Some(oid.clone())),
            _ => Err(format!(
                "the unmerged path {path:?} of the incoming record has no {name} blob or null"
            )),
        };
        unmerged.push(UnmergedPath {
            path: path.clone(),
            base: stage("base")?,
            ours: stage("ours")?,
            theirs: stage("theirs")?,
        });
    }
    Ok(UnfinishedMerge {
        incoming,
        message,
        unmerged,
    })
}

/// One string field of a record, or why it is not one.
fn text<'a>(object: &'a Map<String, Value>, name: &str) -> Result<&'a str, String> {
    match object.get(name) {
        None => Err(format!("the incoming record has no {name}")),
        Some(Value::String(value)) => Ok(value.as_str()),
        Some(_) => Err(format!("the incoming record's {name} is not a string")),
    }
}

fn record_path(gitdir: &Path) -> PathBuf {
    gitdir.join(RECORD[0]).join(RECORD[1])
}

/// The record as the folder holds it now.
pub fn read(gitdir: &Path) -> Found {
    match fs::read(record_path(gitdir)) {
        Ok(bytes) => match Record::parse(&bytes) {
            Ok(record) => Found::Recorded(record),
            Err(reason) => Found::Unreadable(reason),
        },
        Err(cause) if cause.kind() == ErrorKind::NotFound => Found::None,
        Err(cause) => Found::Unreadable(format!("the incoming record could not be read: {cause}")),
    }
}

/// Flush a directory's entries, so a rename or removal in it is durable.
fn sync_directory(directory: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        fs::File::open(directory)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = directory;
        Ok(())
    }
}

/// Put `record` in place: written to a scratch name, flushed, renamed, and
/// the rename flushed. The caller has checked that no record exists.
pub fn write(gitdir: &Path, record: &Record) -> Written {
    let directory = gitdir.join(RECORD[0]);
    if let Err(cause) = fs::create_dir_all(&directory) {
        return Written::Absent(format!(
            "the incoming record's directory could not be made: {cause}"
        ));
    }
    let scratch = directory.join(format!("incoming-{}.json.partial", record.operation_id));
    let written = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&scratch)?;
        file.write_all(&record.to_bytes())?;
        file.sync_all()
    })();
    if let Err(cause) = written {
        let _ = fs::remove_file(&scratch);
        return Written::Absent(format!("the incoming record could not be written: {cause}"));
    }
    if let Err(cause) = fs::rename(&scratch, record_path(gitdir)) {
        let _ = fs::remove_file(&scratch);
        return Written::Absent(format!(
            "the incoming record could not be put in place: {cause}"
        ));
    }
    match sync_directory(&directory) {
        Ok(()) => Written::Durable,
        Err(cause) => Written::Unknown(format!(
            "the incoming record is in place, but could not be flushed: {cause}"
        )),
    }
}

/// Remove the record. A record already gone is not an error.
pub fn clear(gitdir: &Path) -> Result<(), String> {
    match fs::remove_file(record_path(gitdir)) {
        Ok(()) => {
            // Not flushing only risks the record reappearing after a crash,
            // when the branch already names its target: recovery clears it.
            let _ = sync_directory(&gitdir.join(RECORD[0]));
            Ok(())
        }
        Err(cause) if cause.kind() == ErrorKind::NotFound => Ok(()),
        Err(cause) => Err(format!("the incoming record could not be removed: {cause}")),
    }
}

/// Pin both commits of `record`. Pins of an earlier operation that has no
/// record are pruned first.
pub fn pin(git: &Git, record: &Record) -> Result<(), Failure> {
    git.delete_refs_under(PINS)?;
    let mut refs = vec![(record.pin("after"), record.next_head.clone())];
    if let Some(expected) = &record.expected_head {
        refs.push((record.pin("before"), expected.clone()));
    }
    // The commit an unfinished merge records as `MERGE_HEAD`, pinned on its
    // own: the commit of its files names it only as a parent.
    if let Some(merge) = &record.merge {
        refs.push((record.pin("incoming"), merge.incoming.clone()));
    }
    git.create_refs(&refs)
}

/// Release the pins of `record`. Called only after its record is gone.
pub fn unpin(git: &Git, record: &Record) -> Result<(), Failure> {
    git.delete_refs_under(&format!("{PINS}{}/", record.operation_id))
}

/// The paths an update changes, with each path's before and after entry as
/// `(mode, blob)`. `None` is absence.
pub struct Plan {
    pub before: BTreeMap<String, (String, String)>,
    pub after: BTreeMap<String, (String, String)>,
    pub affected: Vec<String>,
}

impl Plan {
    pub fn derive(git: &Git, record: &Record) -> Result<Self, Failure> {
        let before = match &record.expected_head {
            Some(head) => git.tree_files(head)?,
            None => BTreeMap::new(),
        };
        let after = git.tree_files(&record.next_head)?;
        let affected = before
            .keys()
            .chain(after.keys())
            .collect::<BTreeSet<&String>>()
            .into_iter()
            .filter(|path| before.get(*path) != after.get(*path))
            .cloned()
            .collect();
        Ok(Self {
            before,
            after,
            affected,
        })
    }

    /// Whether `tree` holds anything below `directory`.
    pub fn holds_beneath(tree: &BTreeMap<String, (String, String)>, directory: &str) -> bool {
        let prefix = format!("{directory}/");
        tree.range(prefix.clone()..)
            .next()
            .is_some_and(|(path, _)| path.starts_with(&prefix))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_record_reads_back_exactly_and_anything_else_is_named() {
        let record = Record::new("main", None, "a".repeat(40));
        assert_eq!(Record::parse(&record.to_bytes()), Ok(record.clone()));
        let with_head = Record {
            expected_head: Some("b".repeat(40)),
            ..record.clone()
        };
        assert_eq!(Record::parse(&with_head.to_bytes()), Ok(with_head.clone()));
        let merging = Record {
            merge: Some(UnfinishedMerge {
                incoming: "d".repeat(40),
                message: "Merge remote-tracking branch 'origin/main'".to_string(),
                unmerged: vec![UnmergedPath {
                    path: "notes/color.txt".to_string(),
                    base: None,
                    ours: Some("e".repeat(40)),
                    theirs: Some("f".repeat(40)),
                }],
            }),
            ..with_head
        };
        assert_eq!(Record::parse(&merging.to_bytes()), Ok(merging.clone()));
        let no_head = Record {
            expected_head: None,
            ..merging
        };
        assert_eq!(
            Record::parse(&no_head.to_bytes()),
            Err("the incoming record's merge has no expectedHead to stay at".to_string())
        );

        let refused = |text: &str| Record::parse(text.as_bytes()).unwrap_err();
        assert_eq!(refused(""), "the incoming record is empty");
        assert!(refused("{").starts_with("the incoming record is not JSON"));
        assert_eq!(refused("[]"), "the incoming record is not a JSON object");
        let next = "c".repeat(40);
        assert_eq!(
            refused(&format!(
                r#"{{"operationId":"x","branch":"main","expectedHead":null,"nextHead":"{next}","paths":[]}}"#
            )),
            "the incoming record has the unexpected field \"paths\""
        );
        assert_eq!(
            refused(r#"{"operationId":"x","branch":"main","expectedHead":null}"#),
            "the incoming record has no nextHead"
        );
        assert_eq!(
            refused(&format!(
                r#"{{"operationId":"x","branch":"main","nextHead":"{next}"}}"#
            )),
            "the incoming record has no expectedHead"
        );
        assert_eq!(
            refused(&format!(
                r#"{{"operationId":"x","branch":"main","expectedHead":"HEAD","nextHead":"{next}"}}"#
            )),
            "the incoming record's expectedHead \"HEAD\" is neither null nor a commit ID"
        );
        assert_eq!(
            refused(&format!(
                r#"{{"operationId":"../x","branch":"main","expectedHead":null,"nextHead":"{next}"}}"#
            )),
            "the incoming record's operationId \"../x\" is not an operation ID"
        );
    }

    #[test]
    fn holds_beneath_matches_only_paths_inside_the_directory() {
        let tree: BTreeMap<String, (String, String)> =
            [("a.md", ""), ("a/b.md", ""), ("ab/c.md", "")]
                .into_iter()
                .map(|(path, _)| (path.to_string(), (String::new(), String::new())))
                .collect();
        assert!(Plan::holds_beneath(&tree, "a"));
        assert!(!Plan::holds_beneath(&tree, "a.md"));
        assert!(!Plan::holds_beneath(&tree, "b"));
    }
}
