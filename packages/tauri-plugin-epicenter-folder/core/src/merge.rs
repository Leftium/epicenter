//! A two-parent merge of the folder's head and a fetched commit, prepared as
//! objects only: blobs, trees, and a commit no ref names. Nothing here writes
//! a file, the index, or a ref. This is the native counterpart of
//! `@epicenter/folder`'s `git/merge.ts`, and it classifies paths the same way.
//!
//! Root `kv.json` changed on both sides merges by key (`merge_kv`), and the
//! merged text is the file. Every other path follows Git's rules: unchanged,
//! identical, and one-sided changes keep their exact entries, and a file both
//! sides changed merges by lines with `git merge-file`, only when every
//! version is UTF-8 with no NUL byte and no line break the browser's line
//! merge would drop (a lone carriage return, U+2028, U+2029). Such a file is
//! a `binary` conflict, a link, executable, or submodule among its versions is
//! unmergeable, and so is a path a `merge` attribute would merge differently.
//! A file on one side where the other has a directory is a `shape` conflict.
//!
//! Histories that share no commit merge over an empty base when the caller
//! allows unrelated histories, as `git merge --allow-unrelated-histories`
//! does: every file is an addition, a path both sides hold with different
//! bytes conflicts like any competing change, and root `kv.json` merges by key
//! against no base.
//!
//! A conflict is only ever reported: the merge writes no conflict markers and
//! no commit for it, and the caller publishes nothing.

use std::collections::{BTreeMap, BTreeSet};

use crate::git::{Author, Failure, Git};
use crate::history::{ConflictVersion, DeletedBy, MergeConflict, MergeSide};
use crate::kv_merge::{self, KvMerge};
use crate::paths::ancestors;

/// The one file merged by key rather than by line.
pub const ROOT_KV: &str = "kv.json";
const PLAIN: &str = "100644";
/// A submodule's tree entry: a commit, not file bytes.
const GITLINK: &str = "160000";

type Entry = (String, String);
type Files = BTreeMap<String, Entry>;

pub enum Prepared {
    /// The merge commit, whose parents are the head and the fetched commit.
    Merged {
        commit: String,
        files: Files,
    },
    Conflicted {
        conflicts: Vec<MergeConflict>,
    },
    Unmergeable {
        paths: Vec<String>,
        reason: String,
    },
}

/// Whether the browser's line merge reads these bytes back exactly: UTF-8,
/// no NUL, and no line break other than `\n` or `\r\n`.
fn merges_as_text(bytes: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return false;
    };
    if text.contains(['\0', '\u{2028}', '\u{2029}']) {
        return false;
    }
    let bytes = text.as_bytes();
    bytes
        .iter()
        .enumerate()
        .all(|(at, byte)| *byte != b'\r' || bytes.get(at + 1) == Some(&b'\n'))
}

/// Merge `head` and `fetched` over their single merge base `base`, or over an
/// empty tree when `base` is `None`: histories that share no commit, which a
/// caller merges only when asked to allow unrelated histories.
pub fn prepare(
    git: &Git,
    base: Option<&str>,
    head: &str,
    fetched: &str,
    author: &Author,
    message: &str,
) -> Result<Prepared, Failure> {
    let b = match base {
        Some(base) => git.tree_files(base)?,
        None => BTreeMap::new(),
    };
    let o = git.tree_files(head)?;
    let t = git.tree_files(fetched)?;
    let mut conflicts: Vec<MergeConflict> = Vec::new();
    let mut result: Files = BTreeMap::new();

    // Root kv.json, when both sides changed it differently. `kv` is what the
    // merge holds there: the merged blob, `None` for no file, or `None` at
    // the outer level to leave it to the ordinary rules.
    let mut kv: Option<Option<String>> = None;
    let (kb, ko, kt) = (b.get(ROOT_KV), o.get(ROOT_KV), t.get(ROOT_KV));
    if ko != kt && ko != kb && kt != kb {
        let plain = [kb, ko, kt]
            .iter()
            .all(|entry| entry.is_none_or(|(mode, _)| mode == PLAIN))
            && [&b, &o, &t].iter().all(|files| {
                !files
                    .keys()
                    .any(|path| path.starts_with(&format!("{ROOT_KV}/")))
            });
        if !plain {
            return Ok(Prepared::Unmergeable {
                paths: vec![ROOT_KV.to_string()],
                reason: "kv.json is not a plain file on every side".to_string(),
            });
        }
        let mut texts: [Option<String>; 3] = [None, None, None];
        let mut invalid: Option<MergeSide> = None;
        for (at, (entry, side)) in [
            (kb, MergeSide::Base),
            (ko, MergeSide::Ours),
            (kt, MergeSide::Theirs),
        ]
        .into_iter()
        .enumerate()
        {
            let Some((_, oid)) = entry else { continue };
            match String::from_utf8(git.read_blob(oid)?) {
                Ok(text) => texts[at] = Some(text),
                Err(_) => {
                    invalid.get_or_insert(side);
                }
            }
        }
        let merged = match invalid {
            Some(side) => KvMerge::Invalid {
                side: match side {
                    MergeSide::Base => kv_merge::Side::Base,
                    MergeSide::Ours => kv_merge::Side::Ours,
                    MergeSide::Theirs => kv_merge::Side::Theirs,
                },
            },
            None => kv_merge::merge_kv(
                texts[0].as_deref(),
                texts[1].as_deref(),
                texts[2].as_deref(),
            ),
        };
        match merged {
            KvMerge::Merged { text } => {
                kv = Some(match text {
                    Some(text) => Some(git.write_blob(text.as_bytes())?),
                    None => None,
                })
            }
            KvMerge::Conflict { conflicts: keys } => {
                for key in keys {
                    conflicts.push(MergeConflict::KvKey {
                        path: ROOT_KV.to_string(),
                        key: key.key,
                        base: key.base,
                        ours: key.ours,
                        theirs: key.theirs,
                    });
                }
            }
            KvMerge::FileConflict => conflicts.push(MergeConflict::KvFile {
                path: ROOT_KV.to_string(),
            }),
            KvMerge::Invalid { side } => conflicts.push(MergeConflict::KvInvalid {
                path: ROOT_KV.to_string(),
                side: match side {
                    kv_merge::Side::Base => MergeSide::Base,
                    kv_merge::Side::Ours => MergeSide::Ours,
                    kv_merge::Side::Theirs => MergeSide::Theirs,
                },
            }),
        }
        // A conflicted kv.json stands as our file while the rest merges and
        // reports its own conflicts.
        if kv.is_none() {
            kv = Some(ko.map(|(_, oid)| oid.clone()));
        }
    }

    // Every other path by Git's rules. `present` is where a file will be, so
    // a file on one side under a directory on the other is found.
    let mut present: BTreeSet<String> = BTreeSet::new();
    let mut text_merges: Vec<String> = Vec::new();
    let paths: BTreeSet<&String> = b.keys().chain(o.keys()).chain(t.keys()).collect();
    for path in paths {
        if path == ROOT_KV {
            if let Some(kept) = &kv {
                if let Some(oid) = kept {
                    present.insert(path.clone());
                    result.insert(path.clone(), (PLAIN.to_string(), oid.clone()));
                }
                continue;
            }
        }
        let (eb, eo, et) = (b.get(path), o.get(path), t.get(path));
        if eo == et || eo == eb {
            if let Some(entry) = et {
                present.insert(path.clone());
                result.insert(path.clone(), entry.clone());
            }
            continue;
        }
        if et == eb {
            if let Some(entry) = eo {
                present.insert(path.clone());
                result.insert(path.clone(), entry.clone());
            }
            continue;
        }
        present.insert(path.clone());
        if eo.is_none() || et.is_none() {
            conflicts.push(MergeConflict::Deleted {
                path: path.clone(),
                deleted_by: if eo.is_none() {
                    DeletedBy::Ours
                } else {
                    DeletedBy::Theirs
                },
            });
            continue;
        }
        text_merges.push(path.clone());
    }

    let versions = |path: &str| -> [Option<&Entry>; 3] { [b.get(path), o.get(path), t.get(path)] };
    let special: Vec<String> = text_merges
        .iter()
        .filter(|path| {
            versions(path)
                .iter()
                .flatten()
                .any(|(mode, _)| mode != PLAIN)
        })
        .cloned()
        .collect();
    if !special.is_empty() {
        return Ok(Prepared::Unmergeable {
            paths: special,
            reason: "both sides changed a file that is a symbolic link, executable, or submodule in one of its versions".to_string(),
        });
    }
    let mut as_text: Vec<String> = Vec::new();
    for path in &text_merges {
        let mut text = true;
        for (_, oid) in versions(path).into_iter().flatten() {
            if !merges_as_text(&git.read_blob(oid)?) {
                text = false;
                break;
            }
        }
        if text {
            as_text.push(path.clone());
        } else {
            conflicts.push(MergeConflict::Binary { path: path.clone() });
        }
    }
    if !as_text.is_empty() {
        for commit in [base, Some(head), Some(fetched)].into_iter().flatten() {
            if let Some((path, attribute)) =
                git.merge_attribute(commit, as_text.iter().map(String::as_str))?
            {
                return Ok(Prepared::Unmergeable {
                    paths: vec![path.clone()],
                    reason: format!(
                        "the Git attribute {attribute} applies to {path}, and this folder merges text only by Git's default rule"
                    ),
                });
            }
        }
    }

    let mut shapes: BTreeSet<String> = BTreeSet::new();
    for path in &present {
        for parent in ancestors(path) {
            if present.contains(parent) {
                shapes.insert(parent.to_string());
            }
        }
    }
    for path in &shapes {
        conflicts.push(MergeConflict::Shape { path: path.clone() });
    }

    // Git's own line merge, where no file stands against a directory.
    if shapes.is_empty() {
        for path in &as_text {
            let [eb, eo, et] = versions(path);
            let merged = git.merge_blobs(
                eb.map(|(_, oid)| oid.as_str()),
                &eo.expect("both sides have a text merge's file").1,
                &et.expect("both sides have a text merge's file").1,
            )?;
            match merged {
                Some(oid) => {
                    result.insert(path.clone(), (PLAIN.to_string(), oid));
                }
                None => conflicts.push(MergeConflict::Content { path: path.clone() }),
            }
        }
    }
    // Stable: a path's reasons keep the order they were found in.
    conflicts.sort_by(|left, right| left.path().cmp(right.path()));

    if !conflicts.is_empty() {
        return Ok(Prepared::Conflicted { conflicts });
    }
    let tree = git.write_entries_tree(&result)?;
    let commit = git.write_commit_with_parents(&tree, &[head, fetched], message, author)?;
    Ok(Prepared::Merged {
        commit,
        files: result,
    })
}

/// Each conflicted file's committed bytes at `head` and at `fetched`, once per
/// path in the conflicts' order, `None` where that side has no file. Both are
/// the commits the merge was prepared from, never a ref read again. A path
/// that is a directory on one side (`shape`) has no file versions to compare
/// and is left out.
pub fn conflict_versions(
    git: &Git,
    conflicts: &[MergeConflict],
    head: &str,
    fetched: &str,
) -> Result<Vec<ConflictVersion>, Failure> {
    let shapes: BTreeSet<&str> = conflicts
        .iter()
        .filter(|conflict| matches!(conflict, MergeConflict::Shape { .. }))
        .map(MergeConflict::path)
        .collect();
    let ours = git.tree_files(head)?;
    let theirs = git.tree_files(fetched)?;
    let bytes = |files: &Files, path: &str| -> Result<Option<Vec<u8>>, Failure> {
        match files.get(path) {
            Some((mode, oid)) if mode != GITLINK => git.read_blob(oid).map(Some),
            _ => Ok(None),
        }
    };
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    let mut versions = Vec::new();
    for conflict in conflicts {
        let path = conflict.path();
        if shapes.contains(path) || !seen.insert(path) {
            continue;
        }
        versions.push(ConflictVersion {
            path: path.to_string(),
            ours: bytes(&ours, path)?,
            theirs: bytes(&theirs, path)?,
        });
    }
    Ok(versions)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_is_what_the_browser_line_merge_keeps() {
        assert!(merges_as_text(b"one\r\ntwo\nthree"));
        assert!(!merges_as_text(b"lone\rreturn\n"));
        assert!(!merges_as_text(b"nul\0byte\n"));
        assert!(!merges_as_text(&[0xff, b'\n']));
        assert!(!merges_as_text("line\u{2028}separator".as_bytes()));
        assert!(!merges_as_text(b"ends with\r"));
    }
}
