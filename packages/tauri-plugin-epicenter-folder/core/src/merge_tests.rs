//! Merging incoming history in the native owner, published or left for a
//! person to finish.
//!
//! Each test makes upstream history with plain Git, fetches it into a folder
//! the owner holds, and merges. The repository is checked with plain Git as
//! another program would see it: files, `git status`, `git ls-files -u`, the
//! merge state, and commit parents.
//!
//! Key behaviors:
//! - A clean divergence records one commit with the original local head and
//!   the pinned fetched head as parents; root `kv.json` merges by key.
//! - By default a conflict writes no file, index entry, or ref.
//! - `Leave` publishes Git's own unfinished merge: markers, exact unmerged
//!   stages, `MERGE_HEAD`, `MERGE_MSG`, and `ORIG_HEAD`, with the branch where
//!   it was. It is refused before anything runs with automatic history.
//! - The merge state survives reopening, before and after staging. A save
//!   resolves nothing; a staged commit while a path is unmerged is
//!   `Unmerged` and writes nothing; whole-folder commits and pulls wait.
//! - The merge commit has both original parents even when the resolved tree
//!   is the local tree, and a fetch during resolution never changes its
//!   second parent. Staging a base-equal resolution or a deletion clears the
//!   stages.
//! - A publication stopped partway is pending, blocks commits and staging,
//!   and is recovered only when asked, keeping later edits to other files;
//!   recovery never resolves a path, and refuses a marker file edited since.
//! - Merge state left after its merge commit never becomes a second parent
//!   again.
//! - A branch moved after a staged merge commit pinned its parents is
//!   refused, keeping files, index, and merge state; the commit's tree is the
//!   one Git writes from the index, intent-to-add entries left out.

use std::path::{Path, PathBuf};

use crate::git::Remote;
use crate::history::{
    CommitOutcome, GitError, MergeConflict, MergeConflicts, MergeError, MergeOutcome,
    PendingIncoming, PullError, PullOutcome, RecoverOutcome,
};
use crate::owner::{FolderConfig, FolderOwner};
use crate::testing::{config, git, overwrite, TempDir};

const MARKED: &str = "<<<<<<< HEAD\nred\n=======\ngreen\n>>>>>>> origin/main\n";

struct Scene {
    _temp: TempDir,
    bare: PathBuf,
    upstream: PathBuf,
    root: PathBuf,
    owner: Option<FolderOwner>,
}

fn put(directory: &Path, path: &str, content: &str) {
    let file = directory.join(path);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(file, content).unwrap();
}

fn open_local(root: &Path, bare: &Path, commit_on_edit: bool) -> FolderOwner {
    FolderOwner::open(FolderConfig {
        commit_on_edit,
        remote: Some(Remote {
            url: bare.display().to_string(),
            branch: "main".to_string(),
        }),
        ..config(root)
    })
    .unwrap()
}

/// Upstream commits `base`; the folder fast-forwards to it.
fn scene(label: &str, base: &[(&str, &str)], commit_on_edit: bool) -> Scene {
    let temp = TempDir::new(label);
    let bare = temp.folder("remote.git");
    git(
        &bare,
        &["init", "--quiet", "--bare", "--initial-branch=main"],
    );
    let upstream = temp.folder("upstream");
    git(&upstream, &["init", "--quiet", "--initial-branch=main"]);
    git(
        &upstream,
        &["remote", "add", "origin", &bare.display().to_string()],
    );
    for (path, content) in base {
        put(&upstream, path, content);
    }
    git(&upstream, &["add", "--all"]);
    git(&upstream, &["commit", "--quiet", "-m", "base"]);
    git(&upstream, &["push", "--quiet", "origin", "main"]);
    let root = temp.folder("local");
    let owner = open_local(&root, &bare, commit_on_edit);
    owner.fetch(None).unwrap();
    assert!(matches!(
        owner.pull_fast_forward(),
        Ok(PullOutcome::FastForwarded { .. })
    ));
    Scene {
        _temp: temp,
        bare,
        upstream,
        root,
        owner: Some(owner),
    }
}

impl Scene {
    fn owner(&self) -> &FolderOwner {
        self.owner.as_ref().unwrap()
    }

    /// Close the owner and open the folder again, as a new process would.
    fn reopen(&mut self, commit_on_edit: bool) {
        if let Some(owner) = self.owner.take() {
            owner.shutdown();
        }
        self.owner = Some(open_local(&self.root, &self.bare, commit_on_edit));
    }

    /// Upstream changes, commits, and pushes; the folder fetches it.
    fn theirs(&self, change: impl FnOnce(&Path)) -> String {
        change(&self.upstream);
        git(&self.upstream, &["add", "--all"]);
        git(&self.upstream, &["commit", "--quiet", "-m", "theirs"]);
        git(&self.upstream, &["push", "--quiet", "origin", "main"]);
        self.owner().fetch(None).unwrap().oid.unwrap()
    }

    /// The folder saves `files` and commits them as its own history.
    fn ours(&self, files: &[(&str, &str)]) -> String {
        let changes: Vec<_> = files
            .iter()
            .map(|(path, content)| overwrite(path, content))
            .collect();
        self.owner().apply(&changes).unwrap();
        match self.owner().commit() {
            CommitOutcome::Committed { oid, .. } => oid,
            other => panic!("expected a commit, got {other:?}"),
        }
    }

    fn read(&self, path: &str) -> String {
        std::fs::read_to_string(self.root.join(path)).unwrap()
    }

    fn git(&self, args: &[&str]) -> String {
        git(&self.root, args)
    }

    fn head(&self) -> String {
        self.git(&["rev-parse", "main"])
    }

    fn parents(&self, commit: &str) -> String {
        self.git(&["log", "-1", "--format=%P", commit])
    }

    /// Everything a refused merge must leave: files, the index's bytes, every
    /// ref, and the merge state.
    #[allow(clippy::type_complexity)]
    fn untouched(
        &self,
    ) -> (
        Vec<(String, Vec<u8>)>,
        Vec<u8>,
        String,
        Vec<Option<Vec<u8>>>,
    ) {
        let files = crate::testing::tree(&self.root)
            .into_iter()
            .filter(|(path, _)| !path.starts_with(".git/"))
            .collect();
        (
            files,
            std::fs::read(self.root.join(".git/index")).unwrap(),
            self.git(&["show-ref"]),
            ["MERGE_HEAD", "MERGE_MSG", "ORIG_HEAD"]
                .iter()
                .map(|name| std::fs::read(self.root.join(".git").join(name)).ok())
                .collect(),
        )
    }

    /// Resolve red against green as green and stage it: nothing is unmerged.
    fn resolve_green(&self) {
        self.owner()
            .apply(&[overwrite("notes/color.txt", "green\n")])
            .unwrap();
        self.owner().stage(None).unwrap();
        assert_eq!(self.git(&["ls-files", "-u"]), "");
    }

    /// Another program commits `tree` with `parents` and moves the branch to it.
    fn outside_commit(&self, tree_of: &str, parents: &[&str]) -> String {
        let tree = self.git(&["rev-parse", &format!("{tree_of}^{{tree}}")]);
        let mut args = vec!["commit-tree", tree.as_str(), "-m", "outside"];
        for parent in parents {
            args.extend(["-p", parent]);
        }
        let commit = self.git(&args);
        self.git(&["update-ref", "refs/heads/main", &commit]);
        commit
    }

    fn blob(&self, commit: &str, path: &str) -> String {
        self.git(&["rev-parse", &format!("{commit}:{path}")])
    }

    fn leave(&self) -> MergeOutcome {
        self.owner().merge_incoming(MergeConflicts::Leave).unwrap()
    }
}

fn red_green(label: &str) -> (Scene, String, String, String) {
    let scene = scene(
        label,
        &[("notes/color.txt", "blue\n"), ("keep.md", "keep\n")],
        false,
    );
    let base = scene.head();
    let theirs = scene.theirs(|upstream| {
        put(upstream, "notes/color.txt", "green\n");
        put(upstream, "theirs.md", "theirs\n");
    });
    let ours = scene.ours(&[("notes/color.txt", "red\n"), ("ours.md", "ours\n")]);
    (scene, base, ours, theirs)
}

#[test]
fn a_clean_divergence_records_both_original_parents_and_merges_kv_by_key() {
    let scene = scene(
        "merge-clean",
        &[
            ("kv.json", "{\"theme\":\"light\",\"lang\":\"en\"}"),
            ("notes.md", "one\ntwo\nthree\nfour\nfive\n"),
        ],
        false,
    );
    let theirs = scene.theirs(|upstream| {
        put(
            upstream,
            "kv.json",
            "{ \"lang\": \"zh\", \"theme\": \"light\" }",
        );
        put(upstream, "notes.md", "one\ntwo\nthree\nfour\nFIVE\n");
    });
    let ours = scene.ours(&[
        ("kv.json", "{\"theme\":\"dark\",\"lang\":\"en\"}"),
        ("notes.md", "ONE\ntwo\nthree\nfour\nfive\n"),
    ]);

    let merged = scene
        .owner()
        .merge_incoming(MergeConflicts::Refuse)
        .unwrap();

    let MergeOutcome::Merged {
        from,
        to,
        fetched,
        changed_paths,
    } = merged
    else {
        panic!("expected a merge, got {merged:?}");
    };
    assert_eq!(
        (from.as_str(), fetched.as_str()),
        (ours.as_str(), theirs.as_str())
    );
    assert_eq!(changed_paths, vec!["kv.json", "notes.md"]);
    assert_eq!(scene.head(), to);
    assert_eq!(scene.parents(&to), format!("{ours} {theirs}"));
    assert_eq!(
        scene.read("kv.json"),
        "{\n  \"lang\": \"zh\",\n  \"theme\": \"dark\"\n}\n"
    );
    assert_eq!(scene.read("notes.md"), "ONE\ntwo\nthree\nfour\nFIVE\n");
    assert_eq!(scene.git(&["status", "--porcelain"]), "");
    let snapshot = scene.owner().snapshot();
    assert!(snapshot.pending_incoming.is_none());
    assert!(snapshot.merging.is_none());
    assert!(matches!(
        snapshot.last_merge.as_ref().map(|attempt| &attempt.result),
        Some(crate::history::Settled::Ok {
            value: MergeOutcome::Merged { .. }
        })
    ));
}

#[test]
fn by_default_a_conflict_writes_no_file_index_entry_or_ref() {
    let (scene, _, ours, _) = red_green("merge-refuse");
    let before = scene.untouched();

    let refused = scene
        .owner()
        .merge_incoming(MergeConflicts::Refuse)
        .unwrap_err();

    assert_eq!(
        refused,
        MergeError::Conflicted {
            conflicts: vec![MergeConflict::Content {
                path: "notes/color.txt".to_string()
            }]
        }
    );
    assert_eq!(scene.untouched(), before);
    assert_eq!(scene.head(), ours);
}

#[test]
fn leaving_conflicts_with_automatic_history_is_refused_before_anything_runs() {
    let scene = scene("merge-automatic", &[("a.md", "a\n")], true);
    let before = scene.untouched();
    assert_eq!(
        scene.owner().merge_incoming(MergeConflicts::Leave),
        Err(GitError::AutomaticHistory.into())
    );
    assert_eq!(scene.untouched(), before);
    assert!(scene.owner().snapshot().last_merge.is_none());
}

#[test]
fn red_against_green_is_left_as_git_leaves_it_and_finished_by_a_staged_commit() {
    let (mut scene, base, ours, theirs) = red_green("merge-leave");

    let left = scene.leave();

    assert_eq!(
        left,
        MergeOutcome::Conflicted {
            from: ours.clone(),
            fetched: theirs.clone(),
            conflicts: vec![MergeConflict::Content {
                path: "notes/color.txt".to_string()
            }],
            changed_paths: vec!["notes/color.txt".to_string(), "theirs.md".to_string()],
        }
    );
    assert_eq!(scene.head(), ours);
    assert_eq!(scene.read("notes/color.txt"), MARKED);
    assert_eq!(scene.read("theirs.md"), "theirs\n");
    assert_eq!(
        scene.git(&["status", "--porcelain"]),
        "UU notes/color.txt\nA  theirs.md"
    );
    assert_eq!(
        scene.git(&["ls-files", "-u"]),
        [
            format!(
                "100644 {} 1\tnotes/color.txt",
                scene.blob(&base, "notes/color.txt")
            ),
            format!(
                "100644 {} 2\tnotes/color.txt",
                scene.blob(&ours, "notes/color.txt")
            ),
            format!(
                "100644 {} 3\tnotes/color.txt",
                scene.blob(&theirs, "notes/color.txt")
            ),
        ]
        .join("\n")
    );
    assert_eq!(scene.read(".git/MERGE_HEAD"), format!("{theirs}\n"));
    assert_eq!(scene.read(".git/ORIG_HEAD"), format!("{ours}\n"));
    assert_eq!(
        scene.read(".git/MERGE_MSG"),
        "Merge remote-tracking branch 'origin/main'\n"
    );
    let snapshot = scene.owner().snapshot();
    assert!(snapshot.pending_incoming.is_none());
    let merging = snapshot.merging.clone().unwrap();
    assert_eq!(
        (merging.incoming.as_str(), merging.head.as_deref()),
        (theirs.as_str(), Some(ours.as_str()))
    );
    assert_eq!(merging.unresolved, vec!["notes/color.txt"]);

    // Whole-folder history and new incoming updates wait for the merge.
    assert!(matches!(
        scene.owner().commit(),
        CommitOutcome::Blocked { .. }
    ));
    assert!(matches!(
        scene.owner().pull_fast_forward(),
        Err(PullError::Blocked { .. })
    ));
    assert!(matches!(
        scene.owner().merge_incoming(MergeConflicts::Leave),
        Err(MergeError::Pull {
            error: PullError::Blocked { .. }
        })
    ));

    // A save resolves nothing, and a staged commit refuses, writing nothing.
    scene
        .owner()
        .apply(&[overwrite("notes/color.txt", "green\n")])
        .unwrap();
    let index = std::fs::read(scene.root.join(".git/index")).unwrap();
    assert_eq!(
        scene.owner().commit_staged("Merge"),
        Err(GitError::Unmerged {
            paths: vec!["notes/color.txt".to_string()]
        })
    );
    assert_eq!(std::fs::read(scene.root.join(".git/index")).unwrap(), index);
    assert_eq!(scene.read("notes/color.txt"), "green\n");
    assert_eq!(scene.head(), ours);

    scene.reopen(false);
    assert_eq!(
        scene.owner().snapshot().merging.clone().unwrap().unresolved,
        vec!["notes/color.txt"]
    );

    scene
        .owner()
        .stage(Some(&["notes/color.txt".to_string()]))
        .unwrap();
    assert_eq!(scene.git(&["ls-files", "-u"]), "");
    scene.reopen(false);
    let merging = scene.owner().snapshot().merging.clone().unwrap();
    assert_eq!(merging.incoming, theirs);
    assert!(merging.unresolved.is_empty());

    // The remote moves on while the merge waits; the merge does not.
    let newer = scene.theirs(|upstream| put(upstream, "later.md", "later\n"));
    assert_eq!(scene.git(&["rev-parse", "origin/main"]), newer);

    let committed = scene.owner().commit_staged("Merge green").unwrap();
    assert_eq!(committed.parent.as_deref(), Some(ours.as_str()));
    assert_eq!(committed.incoming.as_deref(), Some(theirs.as_str()));
    assert_eq!(committed.merge_state_warning, None);
    assert_eq!(scene.head(), committed.oid);
    assert_eq!(scene.parents(&committed.oid), format!("{ours} {theirs}"));
    assert!(!scene.root.join(".git/MERGE_HEAD").exists());
    assert!(scene.owner().snapshot().merging.is_none());
    assert_eq!(scene.git(&["status", "--porcelain"]), "");
}

#[test]
fn a_resolution_equal_to_the_local_tree_or_the_base_still_records_both_parents() {
    for (label, resolution) in [("merge-keep-local", "red\n"), ("merge-keep-base", "blue\n")] {
        let (scene, _, ours, theirs) = red_green(label);
        scene.leave();
        scene
            .owner()
            .apply(&[
                overwrite("notes/color.txt", resolution),
                overwrite("theirs.md", "theirs\n"),
            ])
            .unwrap();
        if resolution == "red\n" {
            // Back to exactly the local tree.
            std::fs::remove_file(scene.root.join("theirs.md")).unwrap();
        }
        scene.owner().stage(None).unwrap();
        assert_eq!(scene.git(&["ls-files", "-u"]), "", "{label}");
        let committed = scene.owner().commit_staged("Resolved").unwrap();
        assert_eq!(
            scene.parents(&committed.oid),
            format!("{ours} {theirs}"),
            "{label}"
        );
        if resolution == "red\n" {
            assert_eq!(
                scene.git(&["rev-parse", &format!("{}^{{tree}}", committed.oid)]),
                scene.git(&["rev-parse", &format!("{ours}^{{tree}}")])
            );
        }
    }
}

#[test]
fn a_deletion_against_a_change_is_left_as_the_changed_file_and_resolved_by_staging_its_removal() {
    let scene = scene(
        "merge-delete",
        &[("gone.md", "kept\n"), ("keep.md", "keep\n")],
        false,
    );
    let theirs = scene.theirs(|upstream| put(upstream, "gone.md", "changed\n"));
    scene
        .owner()
        .apply(&[crate::files::FileChange::Remove {
            path: "gone.md".to_string(),
            expected_sha256: None,
        }])
        .unwrap();
    let ours = match scene.owner().commit() {
        CommitOutcome::Committed { oid, .. } => oid,
        other => panic!("{other:?}"),
    };

    let left = scene.leave();

    assert!(matches!(
        &left,
        MergeOutcome::Conflicted { conflicts, .. }
            if conflicts == &[MergeConflict::Deleted {
                path: "gone.md".to_string(),
                deleted_by: crate::history::DeletedBy::Ours,
            }]
    ));
    assert_eq!(scene.read("gone.md"), "changed\n");
    assert_eq!(scene.git(&["status", "--porcelain"]), "DU gone.md");
    std::fs::remove_file(scene.root.join("gone.md")).unwrap();
    scene.owner().stage(Some(&["gone.md".to_string()])).unwrap();
    let committed = scene.owner().commit_staged("Keep it deleted").unwrap();
    assert_eq!(scene.parents(&committed.oid), format!("{ours} {theirs}"));
    assert_eq!(
        scene.git(&["ls-tree", "-r", "--name-only", "HEAD"]),
        "keep.md"
    );
}

#[test]
fn a_conflicting_root_key_is_left_as_markers_with_its_original_stages() {
    let scene = scene(
        "merge-kv",
        &[("kv.json", "{\n  \"theme\": \"light\"\n}\n")],
        false,
    );
    let theirs = scene.theirs(|upstream| put(upstream, "kv.json", "{\n  \"theme\": \"blue\"\n}\n"));
    let ours = scene.ours(&[("kv.json", "{\n  \"theme\": \"dark\"\n}\n")]);

    let left = scene.leave();

    assert!(matches!(
        &left,
        MergeOutcome::Conflicted { conflicts, .. }
            if matches!(conflicts.as_slice(), [MergeConflict::KvKey { key, .. }] if key == "theme")
    ));
    let marked = scene.read("kv.json");
    assert!(marked.contains("<<<<<<< HEAD\n"), "{marked}");
    assert!(marked.contains(">>>>>>> origin/main\n"), "{marked}");
    assert_eq!(scene.git(&["ls-files", "-u", "kv.json"]).lines().count(), 3);
    scene
        .owner()
        .apply(&[overwrite("kv.json", "{\n  \"theme\": \"blue\"\n}\n")])
        .unwrap();
    scene.owner().stage(None).unwrap();
    let committed = scene.owner().commit_staged("Take blue").unwrap();
    assert_eq!(scene.parents(&committed.oid), format!("{ours} {theirs}"));
}

#[test]
fn a_publication_stopped_partway_is_recovered_only_when_asked_and_keeps_later_edits() {
    let (mut scene, _, ours, theirs) = red_green("merge-partial");
    scene.owner().hooks().incoming_boundary =
        Some(std::sync::Arc::new(|name: &str| name == "file:theirs.md"));

    let stopped = scene
        .owner()
        .merge_incoming(MergeConflicts::Leave)
        .unwrap_err();

    assert!(matches!(
        stopped,
        MergeError::Pull {
            error: PullError::Unconfirmed { .. }
        }
    ));
    assert_eq!(scene.read("notes/color.txt"), MARKED);
    assert!(!scene.root.join("theirs.md").exists());
    assert!(!scene.root.join(".git/MERGE_HEAD").exists());
    scene.reopen(false);
    let Some(PendingIncoming::Recorded {
        merge: Some(merge), ..
    }) = scene.owner().snapshot().pending_incoming.clone()
    else {
        panic!("expected a pending merge");
    };
    assert_eq!(merge.incoming, theirs);
    // While it is pending, commits and staging wait; saves continue.
    assert!(matches!(
        scene.owner().commit(),
        CommitOutcome::Blocked { .. }
    ));
    assert!(matches!(
        scene.owner().stage(None),
        Err(GitError::IncomingPending { .. })
    ));
    scene
        .owner()
        .apply(&[overwrite("keep.md", "edited meanwhile\n")])
        .unwrap();

    let recovered = scene.owner().recover_incoming().unwrap();

    assert!(matches!(
        &recovered,
        RecoverOutcome::Completed { changed_paths, .. } if changed_paths == &["theirs.md"]
    ));
    assert_eq!(scene.read("keep.md"), "edited meanwhile\n");
    assert_eq!(scene.read("notes/color.txt"), MARKED);
    assert_eq!(scene.read("theirs.md"), "theirs\n");
    assert_eq!(scene.head(), ours);
    assert_eq!(scene.read(".git/MERGE_HEAD"), format!("{theirs}\n"));
    assert_eq!(scene.git(&["ls-files", "-u"]).lines().count(), 3);
    let snapshot = scene.owner().snapshot();
    assert!(snapshot.pending_incoming.is_none());
    assert_eq!(
        snapshot.merging.as_ref().unwrap().unresolved,
        vec!["notes/color.txt"]
    );
    // Recovering again finds nothing and resolves nothing.
    assert_eq!(scene.owner().recover_incoming(), Ok(RecoverOutcome::None));
    assert_eq!(scene.git(&["ls-files", "-u"]).lines().count(), 3);
}

#[test]
fn recovery_refuses_a_marker_file_edited_since_and_finishes_merge_state_that_stopped() {
    let (mut scene, _, ours, theirs) = red_green("merge-partial-edited");
    scene.owner().hooks().incoming_boundary =
        Some(std::sync::Arc::new(|name: &str| name == "file:theirs.md"));
    scene
        .owner()
        .merge_incoming(MergeConflicts::Leave)
        .unwrap_err();
    scene.reopen(false);
    scene
        .owner()
        .apply(&[overwrite("notes/color.txt", "my resolution\n")])
        .unwrap();
    assert!(matches!(
        scene.owner().recover_incoming(),
        Err(PullError::RecoveryRefused { paths, .. }) if paths == vec!["notes/color.txt"]
    ));
    assert_eq!(scene.read("notes/color.txt"), "my resolution\n");

    let _ = (ours, theirs);

    // Stopped before its merge state: recovery writes it.
    let (mut scene, _, ours, theirs) = red_green("merge-partial-merge-state");
    scene.owner().hooks().incoming_boundary =
        Some(std::sync::Arc::new(|name: &str| name == "merge-state"));
    scene
        .owner()
        .merge_incoming(MergeConflicts::Leave)
        .unwrap_err();
    assert!(!scene.root.join(".git/MERGE_HEAD").exists());
    assert_eq!(scene.git(&["ls-files", "-u"]).lines().count(), 3);
    scene.reopen(false);
    assert!(scene.owner().snapshot().pending_incoming.is_some());
    assert!(matches!(
        scene.owner().recover_incoming(),
        Ok(RecoverOutcome::Completed { changed_paths, .. }) if changed_paths.is_empty()
    ));
    let merging = scene.owner().snapshot().merging.clone().unwrap();
    assert_eq!(merging.incoming, theirs);
    assert_eq!(merging.head.as_deref(), Some(ours.as_str()));
    assert_eq!(merging.unresolved, vec!["notes/color.txt"]);
    assert_eq!(scene.head(), ours);
    assert!(scene.owner().snapshot().pending_incoming.is_none());
}

#[test]
fn a_published_merge_whose_record_stayed_is_cleared_without_replaying_over_a_resolution() {
    // Everything published, `MERGE_HEAD` last; then the record could not be
    // removed, and a person went on to resolve the marked file.
    let (mut scene, base, ours, theirs) = red_green("merge-record-stayed");
    scene.owner().hooks().incoming_boundary =
        Some(std::sync::Arc::new(|name: &str| name == "clear"));
    scene
        .owner()
        .merge_incoming(MergeConflicts::Leave)
        .unwrap_err();
    assert_eq!(scene.read(".git/MERGE_HEAD"), format!("{theirs}\n"));
    scene.reopen(false);
    assert!(scene.owner().snapshot().pending_incoming.is_some());
    scene
        .owner()
        .apply(&[overwrite("notes/color.txt", "purple\n")])
        .unwrap();
    let stages = scene.git(&["ls-files", "-u"]);
    let index = std::fs::read(scene.root.join(".git/index")).unwrap();

    let recovered = scene.owner().recover_incoming().unwrap();

    assert!(
        matches!(recovered, RecoverOutcome::Cleared { .. }),
        "{recovered:?}"
    );
    assert_eq!(scene.read("notes/color.txt"), "purple\n");
    assert_eq!(scene.read("theirs.md"), "theirs\n");
    assert_eq!(scene.git(&["ls-files", "-u"]), stages);
    assert!(stages.contains(&format!(
        "{} 1\tnotes/color.txt",
        scene.blob(&base, "notes/color.txt")
    )));
    assert_eq!(std::fs::read(scene.root.join(".git/index")).unwrap(), index);
    assert_eq!(scene.head(), ours);
    let snapshot = scene.owner().snapshot();
    assert!(snapshot.pending_incoming.is_none());
    assert_eq!(
        snapshot.merging.as_ref().unwrap().unresolved,
        vec!["notes/color.txt"]
    );
    assert!(scene
        .git(&["for-each-ref", "refs/epicenter/incoming/"])
        .is_empty());
}

#[test]
fn merge_state_left_after_its_merge_commit_never_becomes_a_second_parent_again() {
    let (scene, _, ours, theirs) = red_green("merge-leftover");
    scene.leave();
    scene
        .owner()
        .apply(&[overwrite("notes/color.txt", "green\n")])
        .unwrap();
    scene.owner().stage(None).unwrap();
    let committed = scene.owner().commit_staged("Merge").unwrap();
    // As if removing the merge state had failed after the branch moved.
    std::fs::write(scene.root.join(".git/MERGE_HEAD"), format!("{theirs}\n")).unwrap();
    scene.owner().status().unwrap();
    assert_eq!(
        scene
            .owner()
            .snapshot()
            .merging
            .as_ref()
            .map(|m| m.incoming.clone()),
        Some(theirs.clone())
    );

    assert_eq!(
        scene.owner().commit_staged("Again"),
        Err(GitError::NothingToCommit)
    );

    assert_eq!(scene.head(), committed.oid);
    assert_eq!(scene.parents(&committed.oid), format!("{ours} {theirs}"));
    assert!(!scene.root.join(".git/MERGE_HEAD").exists());
    assert!(scene.owner().snapshot().merging.is_none());
}

#[test]
fn leftover_merge_state_is_complete_only_at_the_exact_merge_commit() {
    // The merge was committed, then another program committed on top of it,
    // and the merge state its failed removal left is still there. The branch
    // contains the incoming commit, but its latest parents are not the
    // merge's: nothing is cleared or committed.
    let (scene, _, _, theirs) = red_green("merge-leftover-descendant");
    scene.leave();
    scene.resolve_green();
    let committed = scene.owner().commit_staged("Merge").unwrap();
    let later = scene.outside_commit(&committed.oid, &[&committed.oid]);
    std::fs::write(scene.root.join(".git/MERGE_HEAD"), format!("{theirs}\n")).unwrap();
    let before = scene.untouched();

    assert!(matches!(
        scene.owner().commit_staged("Again"),
        Err(GitError::BranchMoved { actual: Some(actual), .. }) if actual == later
    ));

    assert_eq!(scene.untouched(), before);
    assert_eq!(scene.head(), later);
}

#[test]
fn a_staged_commit_keeps_orig_head_as_the_first_parent_or_refuses_without_writing() {
    // Another program moves the branch to a descendant of the local head
    // while the resolution waits: the merge would lose its first parent.
    let (scene, _, ours, theirs) = red_green("merge-orig-descendant");
    scene.leave();
    scene.resolve_green();
    let elsewhere = scene.outside_commit(&ours, &[&ours]);
    let before = scene.untouched();

    assert_eq!(
        scene.owner().commit_staged("Merge"),
        Err(GitError::BranchMoved {
            expected: Some(ours.clone()),
            actual: Some(elsewhere.clone()),
        })
    );
    assert_eq!(scene.untouched(), before);
    assert_eq!(
        scene
            .owner()
            .snapshot()
            .merging
            .as_ref()
            .map(|m| m.incoming.clone()),
        Some(theirs.clone())
    );

    // A sibling that already contains the incoming commit is not the merge
    // either, and nothing is cleared.
    let sibling = scene.outside_commit(&theirs, &[&theirs]);
    let before = scene.untouched();
    assert!(matches!(
        scene.owner().commit_staged("Merge"),
        Err(GitError::BranchMoved { actual: Some(actual), .. }) if actual == sibling
    ));
    assert_eq!(scene.untouched(), before);

    // Moved back to `ORIG_HEAD`, the merge finishes with both original parents.
    scene.git(&["update-ref", "refs/heads/main", &ours]);
    let committed = scene.owner().commit_staged("Merge").unwrap();
    assert_eq!(scene.parents(&committed.oid), format!("{ours} {theirs}"));
    assert_eq!(committed.parent.as_deref(), Some(ours.as_str()));
    assert!(!scene.root.join(".git/MERGE_HEAD").exists());
}

#[cfg(unix)]
#[test]
fn a_branch_moved_after_a_staged_merge_commit_pins_its_parents_is_refused_and_keeps_the_merge() {
    let (scene, _, ours, theirs) = red_green("merge-moved-during");
    scene.leave();
    scene.resolve_green();
    let tree = format!("{ours}^{{tree}}");
    let sibling = scene.git(&["commit-tree", &tree, "-p", &ours, "-m", "outside"]);
    let (files, index, _, merge_state) = scene.untouched();

    crate::testing::move_branch_before_commit_tree(&scene.root, &sibling);
    assert_eq!(
        scene.owner().commit_staged("Merge"),
        Err(GitError::BranchMoved {
            expected: Some(ours.clone()),
            actual: Some(sibling.clone()),
        })
    );

    let (files_after, index_after, _, merge_state_after) = scene.untouched();
    assert_eq!(files_after, files);
    assert_eq!(index_after, index);
    assert_eq!(merge_state_after, merge_state);
    assert_eq!(scene.head(), sibling);
    assert_eq!(
        scene
            .owner()
            .snapshot()
            .merging
            .as_ref()
            .map(|m| m.incoming.clone()),
        Some(theirs)
    );
}

#[test]
fn a_staged_merge_commit_leaves_intent_to_add_entries_out_and_keeps_staged_empty_files() {
    let (scene, _, ours, theirs) = red_green("merge-intent-to-add");
    scene.leave();
    scene.resolve_green();
    put(&scene.root, "empty.txt", "");
    scene.git(&["add", "empty.txt"]);
    put(&scene.root, "planned.txt", "later\n");
    scene.git(&["add", "--intent-to-add", "planned.txt"]);
    let index = std::fs::read(scene.root.join(".git/index")).unwrap();

    let committed = scene.owner().commit_staged("Merge").unwrap();

    assert_eq!(scene.parents(&committed.oid), format!("{ours} {theirs}"));
    assert_eq!(std::fs::read(scene.root.join(".git/index")).unwrap(), index);
    assert_eq!(
        scene.git(&[
            "ls-tree",
            "--name-only",
            &committed.oid,
            "--",
            "planned.txt"
        ]),
        ""
    );
    assert_eq!(
        scene.git(&["show", &format!("{}:empty.txt", committed.oid)]),
        ""
    );
    assert_eq!(
        scene.git(&["rev-parse", &format!("{}^{{tree}}", committed.oid)]),
        scene.git(&["write-tree"])
    );
}

#[test]
fn a_merge_without_orig_head_is_refused_visibly_and_changes_nothing() {
    let (scene, _, ours, _) = red_green("merge-no-orig");
    scene.leave();
    scene.resolve_green();
    std::fs::remove_file(scene.root.join(".git/ORIG_HEAD")).unwrap();
    let before = scene.untouched();

    let refused = scene.owner().commit_staged("Merge").unwrap_err();

    assert!(
        matches!(&refused, GitError::Failed { cause, .. } if cause.contains("ORIG_HEAD")),
        "{refused:?}"
    );
    assert_eq!(scene.untouched(), before);
    assert_eq!(scene.head(), ours);
    assert!(scene.owner().snapshot().merging.is_some());
}

#[test]
fn stages_left_without_merge_head_block_every_commit_and_change_nothing() {
    let (scene, _, ours, _) = red_green("merge-orphan-stages");
    scene.leave();
    std::fs::remove_file(scene.root.join(".git/MERGE_HEAD")).unwrap();
    scene.owner().status().unwrap();
    assert!(scene.owner().snapshot().merging.is_none());
    let before = scene.untouched();

    assert!(matches!(
        scene.owner().commit(),
        CommitOutcome::Blocked { reason } if reason.contains("notes/color.txt")
    ));
    assert_eq!(
        scene.owner().commit_staged("Commit over it"),
        Err(GitError::Unmerged {
            paths: vec!["notes/color.txt".to_string()]
        })
    );
    assert!(matches!(
        scene.owner().pull_fast_forward(),
        Err(PullError::Blocked { .. })
    ));

    assert_eq!(scene.untouched(), before);
    assert_eq!(scene.head(), ours);
    assert_eq!(scene.git(&["ls-files", "-u"]).lines().count(), 3);
}
