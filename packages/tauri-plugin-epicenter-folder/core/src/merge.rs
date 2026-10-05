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
//! Asked to leave conflicts for a person, the merge gives each conflicted path
//! the bytes a person resolves: the changed side's file against a deletion,
//! Git's conflict markers when every version is text, and otherwise our bytes,
//! as Git leaves a binary conflict. A conflicted root `kv.json` gets ordinary
//! markers too, which are not JSON. The tree of every path goes into a commit
//! whose parents are the head and the fetched commit. That commit is never a
//! branch head or a merge parent: it names the files and index entries an
//! unfinished merge publishes, and each conflicted path keeps the base, ours,
//! and theirs blobs that become its index stages. A shape conflict cannot be
//! left this way and is refused, as is a conflicted path that is not a plain
//! file in one of its versions.

use std::collections::{BTreeMap, BTreeSet};

use crate::git::{Author, Failure, Git};
use crate::history::{DeletedBy, MergeConflict, MergeSide};
use crate::incoming::UnmergedPath;
use crate::kv_merge::{self, KvMerge};
use crate::paths::ancestors;

/// The one file merged by key rather than by line.
pub const ROOT_KV: &str = "kv.json";
const PLAIN: &str = "100644";

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
    /// Conflicts left in place: the commit of the files a person resolves.
    Unfinished {
        commit: String,
        files: Files,
        conflicts: Vec<MergeConflict>,
        unmerged: Vec<UnmergedPath>,
    },
    Unmergeable {
        paths: Vec<String>,
        reason: String,
    },
}

/// The labels Git writes after the opening and closing markers.
pub struct Labels<'a> {
    pub ours: &'a str,
    pub theirs: &'a str,
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

/// `text`, ending in a line break so a marker after it starts a line.
fn terminated(text: &str) -> String {
    if text.is_empty() || text.ends_with('\n') {
        text.to_string()
    } else {
        format!("{text}\n")
    }
}

/// Merge `head` and `fetched` over their single merge base `base`. With
/// `leave`, conflicts are prepared as files instead of refused.
pub fn prepare(
    git: &Git,
    base: &str,
    head: &str,
    fetched: &str,
    author: &Author,
    message: &str,
    labels: Labels<'_>,
    leave: bool,
) -> Result<Prepared, Failure> {
    let b = git.tree_files(base)?;
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
        for commit in [base, head, fetched] {
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
    let markers = (labels.ours, labels.theirs);
    let mut marked: BTreeMap<String, String> = BTreeMap::new();
    if shapes.is_empty() {
        for path in &as_text {
            let [eb, eo, et] = versions(path);
            let (oid, conflicted) = git.merge_blobs(
                eb.map(|(_, oid)| oid.as_str()),
                &eo.expect("both sides have a text merge's file").1,
                &et.expect("both sides have a text merge's file").1,
                markers,
            )?;
            if conflicted {
                conflicts.push(MergeConflict::Content { path: path.clone() });
                marked.insert(path.clone(), oid);
            } else {
                result.insert(path.clone(), (PLAIN.to_string(), oid));
            }
        }
    }
    // Stable: a path's reasons keep the order they were found in.
    conflicts.sort_by(|left, right| left.path().cmp(right.path()));

    if !conflicts.is_empty() && leave && shapes.is_empty() {
        let mut paths: Vec<String> = Vec::new();
        for conflict in &conflicts {
            if paths.last().map(String::as_str) != Some(conflict.path()) {
                paths.push(conflict.path().to_string());
            }
        }
        let unplain: Vec<String> = paths
            .iter()
            .filter(|path| {
                versions(path)
                    .iter()
                    .flatten()
                    .any(|(mode, _)| mode != PLAIN)
            })
            .cloned()
            .collect();
        if !unplain.is_empty() {
            return Ok(Prepared::Unmergeable {
                paths: unplain,
                reason: "a conflicted path is a symbolic link, executable, or submodule in one of its versions, so it cannot be left as a plain file".to_string(),
            });
        }
        let mut unmerged: Vec<UnmergedPath> = Vec::new();
        for path in &paths {
            let [eb, eo, et] = versions(path);
            let oid = |entry: Option<&Entry>| entry.map(|(_, oid)| oid.clone());
            let left = match (eo, et) {
                (None, Some((_, theirs))) => theirs.clone(),
                (Some((_, ours)), None) => ours.clone(),
                (Some((_, ours)), Some((_, theirs))) => {
                    match marked.get(path) {
                        Some(markers) => markers.clone(),
                        None => {
                            let mut text = true;
                            for (_, oid) in [eb, eo, et].into_iter().flatten() {
                                if !merges_as_text(&git.read_blob(oid)?) {
                                    text = false;
                                    break;
                                }
                            }
                            if !text {
                                ours.clone()
                            } else {
                                let (merged, conflicted) = git.merge_blobs(
                                    eb.map(|(_, oid)| oid.as_str()),
                                    ours,
                                    theirs,
                                    markers,
                                )?;
                                if conflicted {
                                    merged
                                } else {
                                    // The path conflicts by key, not by line: one
                                    // region spans both whole sides.
                                    let ours = String::from_utf8(git.read_blob(ours)?)
                                        .map_err(|_| format!("{path} is not UTF-8"))?;
                                    let theirs = String::from_utf8(git.read_blob(theirs)?)
                                        .map_err(|_| format!("{path} is not UTF-8"))?;
                                    git.write_blob(
                                        format!(
                                            "<<<<<<< {}\n{}=======\n{}>>>>>>> {}\n",
                                            labels.ours,
                                            terminated(&ours),
                                            terminated(&theirs),
                                            labels.theirs
                                        )
                                        .as_bytes(),
                                    )?
                                }
                            }
                        }
                    }
                }
                (None, None) => continue,
            };
            result.insert(path.clone(), (PLAIN.to_string(), left));
            unmerged.push(UnmergedPath {
                path: path.clone(),
                base: oid(eb),
                ours: oid(eo),
                theirs: oid(et),
            });
        }
        let tree = git.write_entries_tree(&result)?;
        let commit = git.write_commit_with_parents(&tree, &[head, fetched], message, author)?;
        return Ok(Prepared::Unfinished {
            commit,
            files: result,
            conflicts,
            unmerged,
        });
    }
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
