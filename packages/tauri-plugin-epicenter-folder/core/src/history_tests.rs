//! Native Git history for one folder.
//!
//! Each test opens a disposable folder and compares what the owner reports
//! with what plain `git` sees afterward.
//!
//! Key behaviors:
//! - A save is committed by the owner even after the handle that saved is gone.
//! - A commit pass captures without the file gate: a save lands while a pass
//!   is held, stays visible, and is committed by the pending pass.
//! - A branch moved by another Git process is reported, never retried or
//!   overwritten; held ref and index locks fail or warn without losing files.
//! - Status writes nothing: no object, no index refresh, no lock file.
//! - Commits hold the exact bytes on disk; responses carry no file bytes.
//! - Push, fetch, and fast-forward follow the shared history's rules.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use crate::files::{FileChange, FileExpectation};
use crate::git::Remote;
use crate::history::{CommitOutcome, GitError, Observation, PullError, PullOutcome, PushOutcome};
use crate::messages::{ChangeKind, PathChange};
use crate::owner::{FolderConfig, FolderOwner};
use crate::testing::{config, eventually, git, open, tree, write, TempDir};

fn settled(owner: &FolderOwner) {
    eventually("the commit and push queues to drain", || {
        let activity = owner.snapshot().activity;
        ![activity.commit, activity.push, activity.scan]
            .iter()
            .any(|runner| runner.active || runner.pending)
    });
}

fn save(owner: &FolderOwner, path: &str, content: &str) {
    owner
        .apply(&[write(path, content, FileExpectation::Any)], None)
        .unwrap();
}

fn manual(root: &Path) -> FolderOwner {
    FolderOwner::open(FolderConfig {
        commit_on_edit: false,
        ..config(root)
    })
    .unwrap()
}

fn subjects(root: &Path) -> Vec<String> {
    git(root, &["log", "--format=%s"])
        .lines()
        .map(str::to_string)
        .collect()
}

fn change(path: &str, kind: ChangeKind) -> PathChange {
    PathChange {
        path: path.to_string(),
        kind,
    }
}

// ============================================================================
// Commit passes
// ============================================================================

#[test]
fn a_save_is_committed_after_the_handle_that_saved_is_gone() {
    let temp = TempDir::new("gone");
    let root = temp.folder("notes");
    let owner = open(&root);
    {
        let page = owner.clone();
        save(&page, "a.md", "saved just before the page closed");
        // The page's handle goes away the moment the save returns.
    }
    settled(&owner);
    assert_eq!(subjects(&root), vec!["Add a.md"]);
    assert_eq!(
        git(&root, &["show", "HEAD:a.md"]),
        "saved just before the page closed"
    );
    assert_eq!(
        git(&root, &["log", "-1", "--format=%an <%ae>"]),
        "Test Author <test@example.com>"
    );
    assert_eq!(
        git(&root, &["status", "--porcelain"]),
        "",
        "the index matches the head"
    );
    let Some(attempt) = &owner.snapshot().last_commit else {
        panic!("the pass is recorded in the snapshot");
    };
    assert!(matches!(
        &attempt.result,
        CommitOutcome::Committed { message, changed_paths: 1, index_warning: None, parent: None, .. }
            if message == "Add a.md"
    ));
}

#[test]
fn a_save_lands_while_a_commit_pass_is_held_and_the_pending_pass_commits_it() {
    let temp = TempDir::new("held-pass");
    let root = temp.folder("notes");
    let owner = open(&root);
    let (captured, at_capture) = mpsc::channel::<()>();
    let (release, gate) = mpsc::channel::<()>();
    let gate = Mutex::new(gate);
    let first = AtomicBool::new(true);
    owner.hooks().after_capture = Some(Arc::new(move || {
        if first.swap(false, Ordering::SeqCst) {
            captured.send(()).unwrap();
            gate.lock().unwrap().recv().unwrap();
        }
    }));

    save(&owner, "a.md", "A");
    at_capture.recv().unwrap();
    // Pass A has captured the folder and is held before it publishes.
    let started = Instant::now();
    save(&owner, "b.md", "B");
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "the save did not wait for the held pass"
    );
    let snapshot = owner.snapshot();
    assert!(snapshot.activity.commit.active, "pass A is still held");
    assert!(
        snapshot.activity.commit.pending,
        "B's request is the pending pass"
    );
    assert_eq!(
        owner.read("b.md").unwrap().bytes,
        b"B",
        "B is visible while A is held"
    );

    release.send(()).unwrap();
    eventually("pass A to settle", || {
        owner.snapshot().last_commit.is_some()
    });
    settled(&owner);
    assert_eq!(subjects(&root), vec!["Add b.md", "Add a.md"]);
    assert_eq!(
        git(&root, &["show", "HEAD~1", "--format=", "--name-only"]),
        "a.md"
    );
    assert!(matches!(
        owner.snapshot().files,
        Observation::Observed { stale: false, ref value, .. } if value.changes.is_empty()
    ));
}

#[test]
fn a_rename_cannot_land_inside_a_snapshot_so_the_pass_never_commits_an_empty_tree() {
    let temp = TempDir::new("coherent");
    let root = temp.folder("notes");
    let owner = manual(&root);
    save(&owner, "todos/old.md", "row");
    save(&owner, "todos/old.png", "image");
    owner.commit();
    assert_eq!(
        git(&root, &["ls-tree", "-r", "--name-only", "HEAD"]),
        "todos/old.md\ntodos/old.png"
    );
    save(&owner, "todos/old.md", "row, edited");

    // While the pass holds the file gate to snapshot, a rename of the row and
    // its attachment is requested. It must not land until the snapshot exists.
    let renamer = owner.clone();
    let renamed: Arc<Mutex<Option<std::thread::JoinHandle<()>>>> = Arc::default();
    let handle = Arc::clone(&renamed);
    let landed_during = Arc::new(AtomicBool::new(false));
    let observed = Arc::clone(&landed_during);
    let once = AtomicBool::new(true);
    owner.hooks().during_snapshot = Some(Arc::new(move || {
        if !once.swap(false, Ordering::SeqCst) {
            return;
        }
        let (done, finished) = mpsc::channel();
        let renamer = renamer.clone();
        *handle.lock().unwrap() = Some(std::thread::spawn(move || {
            let moves: Vec<FileChange> = ["md", "png"]
                .iter()
                .map(|extension| FileChange::Move {
                    from: format!("todos/old.{extension}"),
                    to: format!("todos/new.{extension}"),
                    expected: FileExpectation::Any,
                })
                .collect();
            renamer.apply(&moves, None).unwrap();
            // Nobody is listening any more once the hook stopped waiting.
            let _ = done.send(());
        }));
        observed.store(
            finished.recv_timeout(Duration::from_millis(250)).is_ok(),
            Ordering::SeqCst,
        );
    }));

    let outcome = owner.commit().outcome;
    renamed.lock().unwrap().take().unwrap().join().unwrap();
    assert!(
        !landed_during.load(Ordering::SeqCst),
        "the rename waited for the snapshot"
    );
    assert!(
        matches!(outcome, CommitOutcome::Committed { ref message, .. } if message == "Update todos/old.md"),
        "{outcome:?}"
    );
    assert_eq!(
        git(&root, &["ls-tree", "-r", "--name-only", "HEAD"]),
        "todos/old.md\ntodos/old.png"
    );
    assert_eq!(git(&root, &["show", "HEAD:todos/old.md"]), "row, edited");
    assert_eq!(
        owner.children("todos").unwrap().files,
        vec!["new.md", "new.png"]
    );

    assert!(matches!(
        owner.commit().outcome,
        CommitOutcome::Committed {
            changed_paths: 4,
            ..
        }
    ));
    assert_eq!(
        git(&root, &["ls-tree", "-r", "--name-only", "HEAD"]),
        "todos/new.md\ntodos/new.png"
    );
    assert!(
        !root
            .join(".git/epicenter/scratch")
            .read_dir()
            .unwrap()
            .any(|_| true),
        "no snapshot is left behind"
    );
}

#[test]
fn a_save_finishes_while_a_pass_is_held_at_hashing_and_the_pending_pass_covers_it() {
    let temp = TempDir::new("held-hash");
    let root = temp.folder("notes");
    let owner = open(&root);
    let (reached, at_hash) = mpsc::channel::<()>();
    let (release, gate) = mpsc::channel::<()>();
    let gate = Mutex::new(gate);
    let once = AtomicBool::new(true);
    owner.hooks().before_hash = Some(Arc::new(move || {
        if once.swap(false, Ordering::SeqCst) {
            reached.send(()).unwrap();
            gate.lock().unwrap().recv().unwrap();
        }
    }));

    save(&owner, "a.md", "A");
    at_hash.recv().unwrap();
    // Pass A has its snapshot and is held before it hashes a byte.
    let (done, finished) = mpsc::channel();
    let saver = owner.clone();
    let saving = std::thread::spawn(move || {
        save(&saver, "b.md", "B");
        // Overwriting a file A snapshotted must not change what A commits.
        save(&saver, "a.md", "A, rewritten after the snapshot");
        done.send(()).unwrap();
    });
    finished
        .recv_timeout(Duration::from_secs(10))
        .expect("saves finish while pass A is held at hashing");
    saving.join().unwrap();
    let snapshot = owner.snapshot();
    assert!(snapshot.activity.commit.active && snapshot.activity.commit.pending);

    release.send(()).unwrap();
    settled(&owner);
    assert_eq!(subjects(&root), vec!["Update 2 files", "Add a.md"]);
    assert_eq!(
        git(&root, &["show", "HEAD~1:a.md"]),
        "A",
        "pass A committed the bytes it snapshotted"
    );
    assert_eq!(
        git(&root, &["show", "HEAD:a.md"]),
        "A, rewritten after the snapshot"
    );
    assert_eq!(git(&root, &["show", "HEAD:b.md"]), "B");
    assert!(matches!(
        owner.snapshot().files,
        Observation::Observed { stale: false, .. }
    ));
}

#[test]
fn a_terminal_lease_holder_can_commit_without_waiting_for_its_own_lease() {
    let temp = TempDir::new("lease-commit");
    let root = temp.folder("notes");
    let owner = manual(&root);
    let lease = owner.lease().unwrap();
    owner
        .apply(
            &[write("a.md", "from the terminal", FileExpectation::Absent)],
            Some(lease.id()),
        )
        .unwrap();
    let started = Instant::now();
    let outcome = {
        let _waiting = owner.vouch(Some(lease.id()));
        owner.commit().outcome
    };
    assert!(
        matches!(outcome, CommitOutcome::Committed { .. }),
        "{outcome:?}"
    );
    {
        let _waiting = owner.vouch(Some(lease.id()));
        assert!(owner.status().unwrap().changes.is_empty());
    }
    assert!(
        started.elapsed() < Duration::from_secs(20),
        "the pass ran inside the lease"
    );
    // The lease is still the holder: it can publish again.
    owner
        .apply(
            &[write("b.md", "still leased", FileExpectation::Absent)],
            Some(lease.id()),
        )
        .unwrap();
}

#[test]
fn an_observation_captured_before_a_save_is_stale_until_a_later_pass() {
    let temp = TempDir::new("stale");
    let root = temp.folder("notes");
    let owner = manual(&root);
    save(&owner, "a.md", "A");
    let saver = owner.clone();
    let once = AtomicBool::new(true);
    owner.hooks().after_capture = Some(Arc::new(move || {
        if once.swap(false, Ordering::SeqCst) {
            save(&saver, "b.md", "B");
        }
    }));

    let pass = owner.commit();
    assert!(matches!(
        pass.outcome,
        CommitOutcome::Committed { ref message, .. } if message == "Add a.md"
    ));
    // A's commit is not rejected because a save landed after its capture, but
    // its clean observation is older than that save.
    assert!(matches!(
        owner.snapshot().files,
        Observation::Observed { stale: true, .. }
    ));
    assert_eq!(git(&root, &["status", "--porcelain"]), "?? b.md");

    let pass = owner.commit();
    assert!(matches!(
        pass.outcome,
        CommitOutcome::Committed { ref message, .. } if message == "Add b.md"
    ));
    assert!(matches!(
        owner.snapshot().files,
        Observation::Observed { stale: false, .. }
    ));
}

#[test]
fn a_branch_moved_by_another_git_process_is_reported_and_never_overwritten() {
    let temp = TempDir::new("branch-moved");
    let root = temp.folder("notes");
    let owner = manual(&root);
    save(&owner, "a.md", "A");
    let base = match owner.commit().outcome {
        CommitOutcome::Committed { oid, .. } => oid,
        other => panic!("{other:?}"),
    };

    let outside_root = root.clone();
    let once = AtomicBool::new(true);
    owner.hooks().after_capture = Some(Arc::new(move || {
        if once.swap(false, Ordering::SeqCst) {
            git(
                &outside_root,
                &["commit", "--quiet", "--allow-empty", "-m", "outside commit"],
            );
        }
    }));
    save(&owner, "b.md", "B");
    let outside;
    match owner.commit().outcome {
        CommitOutcome::BranchMoved {
            candidate,
            expected,
            actual,
        } => {
            outside = git(&root, &["rev-parse", "HEAD"]);
            assert_eq!(expected.as_deref(), Some(base.as_str()));
            assert_eq!(actual.as_deref(), Some(outside.as_str()));
            assert_ne!(candidate, outside);
            assert_eq!(git(&root, &["cat-file", "-t", &candidate]), "commit");
        }
        other => panic!("the lost compare-and-swap is reported: {other:?}"),
    }
    assert_eq!(subjects(&root), vec!["outside commit", "Add a.md"]);
    assert_eq!(
        owner.read("b.md").unwrap().bytes,
        b"B",
        "the save is still on disk"
    );

    match owner.commit().outcome {
        CommitOutcome::Committed {
            parent, message, ..
        } => {
            assert_eq!(parent.as_deref(), Some(outside.as_str()));
            assert_eq!(message, "Add b.md");
        }
        other => panic!("a fresh pass commits on top: {other:?}"),
    }
}

#[test]
fn bytes_snapshotted_for_one_parent_are_never_committed_on_another() {
    let temp = TempDir::new("requeue");
    let root = temp.folder("notes");
    let owner = manual(&root);
    save(&owner, "a.md", "A");
    owner.commit();

    // After the snapshot, and before this pass reaches the Git lock, the
    // branch and the working file both move, as a fast-forward would do.
    let outside_root = root.clone();
    let once = AtomicBool::new(true);
    owner.hooks().after_snapshot = Some(Arc::new(move || {
        if once.swap(false, Ordering::SeqCst) {
            std::fs::write(outside_root.join("a.md"), "A from the incoming commit").unwrap();
            git(&outside_root, &["commit", "--quiet", "-am", "incoming"]);
        }
    }));
    save(&owner, "b.md", "B");
    let incoming_parent;
    match owner.commit().outcome {
        CommitOutcome::Committed {
            parent, message, ..
        } => {
            assert_eq!(
                message, "Add b.md",
                "the pass started over with a fresh snapshot"
            );
            incoming_parent = parent.unwrap();
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(subjects(&root), vec!["Add b.md", "incoming", "Add a.md"]);
    assert_eq!(git(&root, &["rev-parse", "HEAD~1"]), incoming_parent);
    assert_eq!(
        git(&root, &["show", "HEAD:a.md"]),
        "A from the incoming commit",
        "the older snapshot did not undo the incoming change"
    );
}

#[test]
fn a_held_ref_lock_fails_the_commit_and_leaves_the_saved_bytes() {
    let temp = TempDir::new("ref-lock");
    let root = temp.folder("notes");
    let owner = manual(&root);
    save(&owner, "a.md", "A");
    owner.commit();
    let head = git(&root, &["rev-parse", "HEAD"]);
    let audio: Vec<u8> = (0..200_000u32).map(|index| (index % 251) as u8).collect();
    owner
        .apply(
            &[FileChange::Write {
                path: "rec/take.wav".into(),
                bytes: audio.clone(),
                expected: FileExpectation::Absent,
            }],
            None,
        )
        .unwrap();
    let ref_lock = root.join(".git/refs/heads/main.lock");
    std::fs::write(&ref_lock, "").unwrap();

    let outcome = owner.commit().outcome;
    assert!(
        matches!(outcome, CommitOutcome::Failed { ref error } if error.contains("update-ref")),
        "{outcome:?}"
    );
    assert_eq!(git(&root, &["rev-parse", "HEAD"]), head);
    assert_eq!(owner.read("rec/take.wav").unwrap().bytes, audio);

    std::fs::remove_file(&ref_lock).unwrap();
    assert!(matches!(
        owner.commit().outcome,
        CommitOutcome::Committed { ref message, .. } if message == "Add rec/take.wav"
    ));
}

#[test]
fn a_held_index_lock_commits_with_a_warning_and_a_later_pass_reconciles() {
    let temp = TempDir::new("index-lock");
    let root = temp.folder("notes");
    let owner = manual(&root);
    save(&owner, "a.md", "A");
    owner.commit();
    save(&owner, "a.md", "A2");
    // Staged content that differs from the working bytes, and a staged-only add.
    std::fs::write(root.join("staged-only.md"), "staged").unwrap();
    git(&root, &["add", "staged-only.md"]);
    std::fs::remove_file(root.join("staged-only.md")).unwrap();
    let index_before = std::fs::read(root.join(".git/index")).unwrap();
    let index_lock = root.join(".git/index.lock");
    std::fs::write(&index_lock, "").unwrap();

    match owner.commit().outcome {
        CommitOutcome::Committed {
            message,
            index_warning,
            ..
        } => {
            assert_eq!(message, "Update a.md");
            let warning = index_warning.expect("the index could not be reconciled");
            assert!(warning.contains("index.lock"), "{warning}");
        }
        other => panic!("the branch still moved: {other:?}"),
    }
    assert_eq!(git(&root, &["show", "HEAD:a.md"]), "A2");
    assert_eq!(
        std::fs::read(root.join(".git/index")).unwrap(),
        index_before
    );

    std::fs::remove_file(&index_lock).unwrap();
    assert_eq!(
        owner.commit().outcome,
        CommitOutcome::Unchanged {
            head: Some(git(&root, &["rev-parse", "HEAD"])),
            index_warning: None,
        }
    );
    assert_eq!(
        git(&root, &["status", "--porcelain"]),
        "",
        "staged-only entries are gone"
    );
}

#[test]
fn status_writes_nothing_into_the_folder_or_its_git_directory() {
    let temp = TempDir::new("read-only");
    let root = temp.folder("notes");
    let owner = manual(&root);
    save(&owner, "a.md", "A");
    save(&owner, "keep/b.md", "B");
    owner.commit();
    // Uncommitted work of every kind, plus an index whose stat data is stale.
    save(&owner, "a.md", "A changed");
    save(&owner, "new.md", "untracked");
    owner
        .apply(
            &[FileChange::Remove {
                path: "keep/b.md".into(),
                expected: FileExpectation::Any,
            }],
            None,
        )
        .unwrap();
    std::thread::sleep(Duration::from_millis(20));
    let before = tree(&root);

    let observed = owner.status().unwrap();
    assert_eq!(
        observed.changes,
        vec![
            change("a.md", ChangeKind::Modify),
            change("keep/b.md", ChangeKind::Delete),
            change("new.md", ChangeKind::Add),
        ]
    );
    assert_eq!(observed.head, Some(git(&root, &["rev-parse", "HEAD"])));
    owner.paths().unwrap();
    owner.diff(false, &[]).unwrap();
    owner.log(5).unwrap();
    owner.poll_external();

    let after = tree(&root);
    let names = |files: &[(String, Vec<u8>)]| {
        files
            .iter()
            .map(|(name, _)| name.clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(
        names(&before),
        names(&after),
        "no object, lock, or scratch file appeared"
    );
    assert_eq!(before, after, "no file's bytes changed, the index included");
}

#[test]
fn ignore_rules_narrow_untracked_files_and_tracked_files_survive_them() {
    let temp = TempDir::new("ignore");
    let root = temp.folder("notes");
    let owner = manual(&root);
    save(&owner, "keep.log", "tracked before the rule");
    owner.commit();
    save(&owner, ".gitignore", "*.log\nbuild/\n");
    save(&owner, "keep.log", "tracked and edited");
    save(&owner, "new.log", "ignored");
    save(&owner, "build/out.txt", "ignored directory");
    save(
        &owner,
        "sub/index.sqlite3",
        "a file that happens to share the name",
    );
    std::fs::write(root.join("index.sqlite3"), "generated").unwrap();
    std::fs::write(root.join(".DS_Store"), "scratch").unwrap();
    std::fs::write(root.join(".git/info/exclude"), "excluded.md\n").unwrap();
    save(&owner, "excluded.md", "ignored by info/exclude");

    let expected = vec![
        change(".gitignore", ChangeKind::Add),
        change("keep.log", ChangeKind::Modify),
        change("sub/index.sqlite3", ChangeKind::Add),
    ];
    assert_eq!(owner.status().unwrap().changes, expected);
    assert!(matches!(
        owner.commit().outcome,
        CommitOutcome::Committed { changed_paths: 3, ref message, .. } if message == "Update 3 files"
    ));
    assert_eq!(
        git(&root, &["ls-tree", "-r", "--name-only", "HEAD"]),
        ".gitignore\nkeep.log\nsub/index.sqlite3"
    );
    assert_eq!(git(&root, &["show", "HEAD:keep.log"]), "tracked and edited");
    assert!(owner.status().unwrap().changes.is_empty());
}

#[cfg(unix)]
#[test]
fn what_a_plain_file_commit_cannot_represent_blocks_the_pass_but_not_status() {
    use std::os::unix::fs::PermissionsExt;
    let cases: [(&str, fn(&Path), &str); 6] = [
        (
            "symlink",
            |root| std::os::unix::fs::symlink("a.md", root.join("link.md")).unwrap(),
            "link.md is a symbolic link; automatic commits only write plain files",
        ),
        (
            "executable",
            |root| {
                std::fs::write(root.join("run.sh"), "#!/bin/sh\n").unwrap();
                std::fs::set_permissions(root.join("run.sh"), std::fs::Permissions::from_mode(0o755))
                    .unwrap();
            },
            "run.sh is an executable file; automatic commits only write plain files",
        ),
        (
            "nested",
            |root| {
                std::fs::create_dir_all(root.join("vendor/.git")).unwrap();
            },
            "vendor/.git is nested Git data; automatic commits only write plain files",
        ),
        (
            "attribute",
            |root| std::fs::write(root.join(".gitattributes"), "*.md text eol=crlf\n").unwrap(),
            "a.md has the Git attribute text; automatic commits do not apply attribute filters or conversion",
        ),
        (
            "autocrlf",
            |root| {
                git(root, &["config", "core.autocrlf", "input"]);
            },
            "core.autocrlf is input; automatic commits do not convert line endings",
        ),
        (
            "detached",
            |root| {
                git(root, &["checkout", "--quiet", "--detach"]);
            },
            "HEAD is detached",
        ),
    ];
    for (label, arrange, reason) in cases {
        let temp = TempDir::new(label);
        let root = temp.folder("notes");
        let owner = manual(&root);
        save(&owner, "a.md", "A");
        owner.commit();
        let head = git(&root, &["rev-parse", "HEAD"]);
        arrange(&root);
        save(&owner, "b.md", "B");

        assert_eq!(
            owner.commit().outcome,
            CommitOutcome::Blocked {
                reason: reason.to_string()
            },
            "{label}"
        );
        assert_eq!(git(&root, &["rev-parse", "HEAD"]), head, "{label}");
        assert_eq!(owner.read("b.md").unwrap().bytes, b"B", "{label}");
        let observed = owner.status().expect("status still observes the folder");
        assert!(
            observed.changes.contains(&change("b.md", ChangeKind::Add)),
            "{label}"
        );
    }
}

#[test]
fn sixty_four_mebibytes_of_audio_commit_exactly_and_no_response_carries_a_byte() {
    const FILES: usize = 8;
    const SIZE: usize = 8 * 1024 * 1024;
    let temp = TempDir::new("audio");
    let root = temp.folder("recordings");
    let owner = manual(&root);
    let mut digests = Vec::new();
    for index in 0..FILES {
        // Incompressible enough that every blob is really written.
        let mut state = 0x9e3779b97f4a7c15u64.wrapping_mul(index as u64 + 1);
        let bytes: Vec<u8> = (0..SIZE)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                state as u8
            })
            .collect();
        digests.push(Sha256::digest(&bytes));
        owner
            .apply(
                &[
                    FileChange::Write {
                        path: format!("rec/{index}.wav"),
                        bytes,
                        expected: FileExpectation::Absent,
                    },
                    write(
                        &format!("rec/{index}.md"),
                        "---\ntitle: take\n---\n",
                        FileExpectation::Absent,
                    ),
                ],
                None,
            )
            .unwrap();
    }

    // Pass A hashes and stores 64 MiB. A short save must not wait for it.
    let committing = owner.clone();
    let pass = std::thread::spawn(move || committing.commit());
    eventually("pass A to start", || {
        owner.snapshot().activity.commit.active
    });
    let started = Instant::now();
    save(
        &owner,
        "note.md",
        "written while the audio was being hashed",
    );
    let save_took = started.elapsed();
    let still_hashing = owner.snapshot().activity.commit.active;
    let first = pass.join().unwrap();
    assert!(
        still_hashing,
        "the save returned after {save_took:?}, while pass A was still running"
    );

    let CommitOutcome::Committed { changed_paths, .. } = &first.outcome else {
        panic!("{:?}", first.outcome);
    };
    assert!(
        *changed_paths == 16 || *changed_paths == 17,
        "{changed_paths}"
    );
    let status = owner.status().unwrap();
    let second = owner.commit();
    for (index, digest) in digests.iter().enumerate() {
        let blob = std::process::Command::new("git")
            .args(["cat-file", "blob", &format!("HEAD:rec/{index}.wav")])
            .current_dir(&root)
            .output()
            .unwrap();
        assert_eq!(blob.stdout.len(), SIZE);
        assert_eq!(Sha256::digest(&blob.stdout), *digest, "rec/{index}.wav");
    }
    assert_eq!(
        git(&root, &["show", "HEAD:note.md"]),
        "written while the audio was being hashed"
    );
    assert_eq!(
        git(&root, &["ls-tree", "-r", "HEAD"])
            .lines()
            .filter(|line| !line.starts_with("100644 blob"))
            .count(),
        0,
        "every entry is a plain file"
    );

    let wire = [
        serde_json::to_string(&first).unwrap(),
        serde_json::to_string(&second).unwrap(),
        serde_json::to_string(&status).unwrap(),
        serde_json::to_string(&*owner.snapshot()).unwrap(),
    ];
    for response in &wire {
        assert!(
            response.len() < 4096,
            "{} bytes: {response}",
            response.len()
        );
    }
}

// ============================================================================
// Explicit Git
// ============================================================================

#[test]
fn staged_authoring_is_refused_under_automatic_history_and_works_in_manual_mode() {
    let temp = TempDir::new("staged");
    let automatic_root = temp.folder("automatic");
    let automatic = open(&automatic_root);
    assert_eq!(automatic.stage(None), Err(GitError::AutomaticHistory));
    assert_eq!(
        automatic.commit_staged("message"),
        Err(GitError::AutomaticHistory)
    );

    let root = temp.folder("manual");
    let owner = manual(&root);
    save(&owner, "a.md", "A");
    save(&owner, "b.md", "B");
    std::thread::sleep(Duration::from_millis(50));
    assert!(
        owner.snapshot().last_commit.is_none(),
        "manual mode never commits on save"
    );
    assert_eq!(
        owner.commit_staged("nothing staged"),
        Err(GitError::NothingToCommit)
    );
    assert_eq!(
        owner.commit_staged("  "),
        Err(GitError::InvalidMessage {
            reason: "the commit message is empty".into()
        })
    );

    owner.stage(Some(&["a.md".to_string()])).unwrap();
    let paths = owner.paths().unwrap();
    assert_eq!(
        paths
            .iter()
            .map(|p| format!("{}{} {}", p.index, p.worktree, p.path))
            .collect::<Vec<_>>(),
        vec!["A  a.md", "?? b.md"]
    );
    assert!(owner
        .diff(true, &["a.md".to_string()])
        .unwrap()
        .contains("+A"));
    let (oid, parent) = owner
        .commit_staged("Add the first note\n\nWith a body.")
        .unwrap();
    assert_eq!(parent, None);
    assert_eq!(git(&root, &["rev-parse", "HEAD"]), oid);
    assert_eq!(
        git(&root, &["ls-tree", "-r", "--name-only", "HEAD"]),
        "a.md"
    );

    owner.stage(None).unwrap();
    owner.commit_staged("Add the second").unwrap();
    let log = owner.log(10).unwrap();
    assert_eq!(log.len(), 2);
    assert_eq!(log[0].message.trim_end(), "Add the second");
    assert_eq!(
        log[1].message.trim_end(),
        "Add the first note\n\nWith a body."
    );
    assert_eq!(log[0].parents, vec![oid]);
    assert_eq!(log[0].author.name, "Test Author");
    assert_eq!(owner.log(1).unwrap().len(), 1);
}

// ============================================================================
// Remote
// ============================================================================

fn with_remote(root: &Path, bare: &Path, commit_on_edit: bool) -> FolderOwner {
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

#[test]
fn a_save_is_committed_then_pushed_and_another_folder_fast_forwards_to_it() {
    let temp = TempDir::new("remote");
    let bare = temp.folder("remote.git");
    git(
        &bare,
        &["init", "--quiet", "--bare", "--initial-branch=main"],
    );
    let first_root = temp.folder("first");
    let first = with_remote(&first_root, &bare, true);
    assert_eq!(
        first.fetch().unwrap().oid,
        None,
        "the remote has no branch yet"
    );

    save(&first, "a.md", "A");
    eventually("the save to be pushed", || {
        first.snapshot().last_push.is_some()
    });
    settled(&first);
    let head = git(&first_root, &["rev-parse", "HEAD"]);
    assert_eq!(
        first.snapshot().last_push.as_ref().unwrap().result,
        PushOutcome::Pushed { oid: head.clone() }
    );
    assert_eq!(git(&bare, &["rev-parse", "main"]), head);
    let Observation::Observed { value: sync, .. } = &first.snapshot().sync else {
        panic!("sync is observed after a push");
    };
    assert_eq!(
        (sync.ahead, sync.behind, sync.remote.as_deref()),
        (0, 0, Some(head.as_str()))
    );

    let second_root = temp.folder("second");
    let second = with_remote(&second_root, &bare, false);
    assert_eq!(second.pull_fast_forward(), Err(PullError::NoFetchedHead));
    std::fs::write(second_root.join(".git/info/exclude"), "ignored.md\n").unwrap();
    std::fs::write(second_root.join("ignored.md"), "kept").unwrap();
    assert_eq!(second.fetch().unwrap().oid, Some(head.clone()));
    assert_eq!(
        second.pull_fast_forward(),
        Ok(PullOutcome::FastForwarded {
            from: None,
            to: head.clone(),
            changed_paths: vec!["a.md".to_string()],
        })
    );
    assert_eq!(second.read("a.md").unwrap().bytes, b"A");
    assert_eq!(second.read("ignored.md").unwrap().bytes, b"kept");
    assert_eq!(git(&second_root, &["rev-parse", "HEAD"]), head);
    assert_eq!(git(&second_root, &["status", "--porcelain"]), "");
    assert_eq!(
        second.pull_fast_forward(),
        Ok(PullOutcome::UpToDate {
            head: Some(head.clone())
        })
    );

    // An edit, a removal, and an addition travel as one fast-forward.
    save(&first, "a.md", "A2");
    save(&first, "dir/b.md", "B");
    settled(&first);
    let next = git(&first_root, &["rev-parse", "HEAD"]);
    eventually("the remote to hold the newest commit", || {
        git(&bare, &["rev-parse", "main"]) == next
    });
    second.fetch().unwrap();
    std::fs::write(second_root.join("a.md"), "local edit").unwrap();
    std::fs::write(second_root.join("untracked.md"), "new local work").unwrap();
    assert_eq!(
        second.pull_fast_forward(),
        Err(PullError::Dirty {
            paths: vec!["a.md".to_string(), "untracked.md".to_string()]
        })
    );
    std::fs::write(second_root.join("a.md"), "A").unwrap();
    std::fs::remove_file(second_root.join("untracked.md")).unwrap();
    std::fs::write(second_root.join(".git/info/exclude"), "ignored.md\ndir/\n").unwrap();
    save(&second, "dir/b.md", "an ignored file in the way");
    assert_eq!(
        second.pull_fast_forward(),
        Err(PullError::Collision {
            paths: vec!["dir/b.md".to_string()]
        })
    );
    assert_eq!(
        second.read("dir/b.md").unwrap().bytes,
        b"an ignored file in the way"
    );
    std::fs::remove_dir_all(second_root.join("dir")).unwrap();
    assert!(matches!(
        second.pull_fast_forward(),
        Ok(PullOutcome::FastForwarded { ref to, ref changed_paths, .. })
            if *to == next && *changed_paths == vec!["a.md".to_string(), "dir/b.md".to_string()]
    ));
    assert_eq!(second.read("a.md").unwrap().bytes, b"A2");
    assert_eq!(second.read("dir/b.md").unwrap().bytes, b"B");

    // Local history the remote lacks is ahead; unrelated history has diverged.
    save(&second, "c.md", "C");
    second.commit();
    assert!(matches!(
        second.pull_fast_forward(),
        Ok(PullOutcome::Ahead { .. })
    ));
    save(&first, "d.md", "D");
    settled(&first);
    eventually("the remote to move again", || {
        git(&bare, &["rev-parse", "main"]) == git(&first_root, &["rev-parse", "HEAD"])
    });
    second.fetch().unwrap();
    assert!(matches!(
        second.pull_fast_forward(),
        Err(PullError::Diverged { .. })
    ));
    assert!(
        matches!(second.push(None), PushOutcome::Failed { .. }),
        "a non-fast-forward push is refused"
    );
}

#[test]
fn a_fast_forward_queued_behind_a_snapshot_is_not_undone_by_that_pass() {
    let temp = TempDir::new("queued-pull");
    let bare = temp.folder("remote.git");
    git(
        &bare,
        &["init", "--quiet", "--bare", "--initial-branch=main"],
    );
    let upstream_root = temp.folder("upstream");
    let upstream = with_remote(&upstream_root, &bare, false);
    save(&upstream, "shared.md", "one");
    upstream.commit();
    assert!(matches!(upstream.push(None), PushOutcome::Pushed { .. }));

    let root = temp.folder("local");
    let owner = with_remote(&root, &bare, false);
    owner.fetch().unwrap();
    owner.pull_fast_forward().unwrap();
    save(&upstream, "shared.md", "two, from upstream");
    upstream.commit();
    assert!(matches!(upstream.push(None), PushOutcome::Pushed { .. }));
    let incoming = owner.fetch().unwrap().oid.unwrap();

    // The pass snapshots a clean folder at the old head. Before it reaches
    // the Git lock, the fast-forward runs: files and branch move to `incoming`.
    let puller = owner.clone();
    let pulled: Arc<Mutex<Option<Result<PullOutcome, PullError>>>> = Arc::default();
    let record = Arc::clone(&pulled);
    let once = AtomicBool::new(true);
    owner.hooks().after_snapshot = Some(Arc::new(move || {
        if once.swap(false, Ordering::SeqCst) {
            *record.lock().unwrap() = Some(puller.pull_fast_forward());
        }
    }));

    let outcome = owner.commit().outcome;
    assert!(
        matches!(pulled.lock().unwrap().as_ref(), Some(Ok(PullOutcome::FastForwarded { to, .. })) if *to == incoming),
        "{:?}",
        pulled.lock().unwrap()
    );
    // The pass did not commit its pre-pull snapshot as a child of the pulled
    // head. It looked again and found nothing to commit.
    assert_eq!(
        outcome,
        CommitOutcome::Unchanged {
            head: Some(incoming.clone()),
            index_warning: None
        }
    );
    assert_eq!(git(&root, &["rev-parse", "HEAD"]), incoming);
    assert_eq!(
        owner.read("shared.md").unwrap().bytes,
        b"two, from upstream"
    );
    assert_eq!(git(&root, &["status", "--porcelain"]), "");
}

#[test]
fn a_fast_forward_never_overwrites_bytes_written_after_it_found_the_folder_clean() {
    let temp = TempDir::new("pull-baseline");
    let bare = temp.folder("remote.git");
    git(
        &bare,
        &["init", "--quiet", "--bare", "--initial-branch=main"],
    );
    let upstream_root = temp.folder("upstream");
    let upstream = with_remote(&upstream_root, &bare, false);
    save(&upstream, "edited.md", "committed");
    save(&upstream, "removed.md", "committed");
    upstream.commit();
    upstream.push(None);

    let root = temp.folder("local");
    let owner = with_remote(&root, &bare, false);
    owner.fetch().unwrap();
    owner.pull_fast_forward().unwrap();
    let head = git(&root, &["rev-parse", "HEAD"]);
    save(&upstream, "edited.md", "incoming");
    upstream
        .apply(
            &[FileChange::Remove {
                path: "removed.md".into(),
                expected: FileExpectation::Any,
            }],
            None,
        )
        .unwrap();
    upstream.commit();
    upstream.push(None);
    owner.fetch().unwrap();

    // The folder was clean when the fast-forward looked. Before it builds its
    // changes, another program writes both files it is about to touch.
    let outside = root.clone();
    owner.hooks().during_pull = Some(Arc::new(move || {
        std::fs::write(outside.join("edited.md"), "written by another program").unwrap();
        std::fs::write(outside.join("removed.md"), "also written outside").unwrap();
    }));

    let refused = owner.pull_fast_forward().unwrap_err();
    let PullError::Refused {
        error:
            crate::files::FileError::Conflict {
                path,
                expected,
                actual,
            },
    } = refused
    else {
        panic!("the outside write is a conflict, not {refused:?}");
    };
    // Removals are applied first; the baseline is the committed bytes.
    assert_eq!(path, "removed.md");
    assert_eq!(
        expected,
        FileExpectation::version(&crate::files::FileVersion::of(b"committed"))
    );
    assert_eq!(
        actual,
        Some(crate::files::FileVersion::of(b"also written outside"))
    );
    assert_eq!(
        std::fs::read_to_string(root.join("edited.md")).unwrap(),
        "written by another program"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("removed.md")).unwrap(),
        "also written outside"
    );
    assert_eq!(
        git(&root, &["rev-parse", "HEAD"]),
        head,
        "the branch did not move"
    );
}

#[test]
fn a_repository_that_configures_its_identity_and_remote_keeps_them() {
    let temp = TempDir::new("repo-config");
    let bare = temp.folder("remote.git");
    git(
        &bare,
        &["init", "--quiet", "--bare", "--initial-branch=main"],
    );

    // Someone set this directory up with Git before the app opened it.
    let configured_root = temp.folder("configured");
    git(
        &configured_root,
        &["init", "--quiet", "--initial-branch=main"],
    );
    git(&configured_root, &["config", "user.name", "Ada Lovelace"]);
    git(
        &configured_root,
        &["config", "user.email", "ada@example.com"],
    );
    git(
        &configured_root,
        &["remote", "add", "origin", &bare.display().to_string()],
    );
    let honoring = |root: &Path| {
        FolderOwner::open(FolderConfig {
            use_repository_author: true,
            use_repository_origin: true,
            ..config(root)
        })
        .unwrap()
    };
    let configured = honoring(&configured_root);
    assert_eq!(configured.author().name, "Ada Lovelace");
    assert_eq!(
        configured.snapshot().remote,
        Some(Remote {
            url: bare.display().to_string(),
            branch: "main".to_string(),
        })
    );
    save(&configured, "a.md", "A");
    eventually("the save to be pushed to the configured remote", || {
        configured.snapshot().last_push.is_some()
    });
    assert_eq!(
        git(&configured_root, &["log", "-1", "--format=%an <%ae>"]),
        "Ada Lovelace <ada@example.com>"
    );
    assert_eq!(
        git(&bare, &["rev-parse", "main"]),
        git(&configured_root, &["rev-parse", "HEAD"])
    );

    // A directory with nothing configured uses what the shell supplied.
    let plain_root = temp.folder("plain");
    let plain = honoring(&plain_root);
    assert_eq!(plain.author(), &crate::testing::author());
    assert_eq!(plain.snapshot().remote, None);

    // Without the options, the repository's configuration is not consulted.
    configured.shutdown();
    let fixed = FolderOwner::open(config(&configured_root)).unwrap();
    assert_eq!(fixed.author(), &crate::testing::author());
    assert_eq!(fixed.snapshot().remote, None);
}

#[test]
fn reading_the_repository_author_does_not_turn_on_its_remote() {
    let temp = TempDir::new("author-only");
    let origin = temp.folder("origin.git");
    git(
        &origin,
        &["init", "--quiet", "--bare", "--initial-branch=main"],
    );
    let origin_before = tree(&origin);

    // The directory has an identity and an `origin`, as a person's might.
    let root = temp.folder("capture");
    git(&root, &["init", "--quiet", "--initial-branch=main"]);
    git(&root, &["config", "user.name", "Ada Lovelace"]);
    git(&root, &["config", "user.email", "ada@example.com"]);
    git(
        &root,
        &["remote", "add", "origin", &origin.display().to_string()],
    );

    let owner = FolderOwner::open(FolderConfig {
        use_repository_author: true,
        ..config(&root)
    })
    .unwrap();
    assert_eq!(
        owner.author(),
        &crate::git::Author {
            name: "Ada Lovelace".to_string(),
            email: "ada@example.com".to_string(),
        }
    );
    assert_eq!(
        owner.snapshot().remote,
        None,
        "the configured origin stays unused"
    );

    // A save is committed locally, by the configured author, and goes nowhere.
    save(&owner, "a.md", "A");
    eventually("the save to be committed", || {
        owner.snapshot().last_commit.is_some()
    });
    settled(&owner);
    std::thread::sleep(Duration::from_millis(200));
    let snapshot = owner.snapshot();
    assert!(matches!(
        snapshot.last_commit.as_ref().unwrap().result,
        CommitOutcome::Committed { .. }
    ));
    assert_eq!(snapshot.last_push, None, "no push was scheduled");
    assert!(!snapshot.activity.push.active && !snapshot.activity.push.pending);
    assert_eq!(
        git(&root, &["log", "-1", "--format=%an <%ae> %s"]),
        "Ada Lovelace <ada@example.com> Add a.md"
    );
    assert_eq!(
        tree(&origin),
        origin_before,
        "the origin was never contacted"
    );
    assert_eq!(
        git(&root, &["for-each-ref", "refs/remotes"]),
        "",
        "no remote-tracking ref was written"
    );
    // Asked directly, remote operations say there is no remote.
    assert_eq!(owner.push(None), PushOutcome::NoRemote);
    assert_eq!(owner.fetch(), Err(GitError::NoRemote));
    owner.shutdown();

    // The origin alone: the remote is used, the supplied author commits.
    let origin_only = FolderOwner::open(FolderConfig {
        use_repository_origin: true,
        ..config(&root)
    })
    .unwrap();
    assert_eq!(origin_only.author(), &crate::testing::author());
    assert_eq!(
        origin_only.snapshot().remote,
        Some(Remote {
            url: origin.display().to_string(),
            branch: "main".to_string(),
        })
    );
    origin_only.shutdown();

    // An explicit remote is honored with discovery off, and is the fallback
    // when discovery is on and the repository has no `origin`.
    let explicit = Remote {
        url: temp.path().join("explicit.git").display().to_string(),
        branch: "main".to_string(),
    };
    let supplied = FolderOwner::open(FolderConfig {
        use_repository_author: true,
        remote: Some(explicit.clone()),
        ..config(&root)
    })
    .unwrap();
    assert_eq!(supplied.snapshot().remote, Some(explicit.clone()));
    supplied.shutdown();
    let bare_root = temp.folder("no-origin");
    let fallback = FolderOwner::open(FolderConfig {
        use_repository_origin: true,
        remote: Some(explicit.clone()),
        ..config(&bare_root)
    })
    .unwrap();
    assert_eq!(fallback.snapshot().remote, Some(explicit));
}

/// A valid Git LFS pointer: what a repository stores for a file whose bytes
/// live elsewhere. No LFS program is involved in writing it here.
const LFS_POINTER: &str = "version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n";

/// A folder that has fast-forwarded to an upstream commit holding real audio,
/// and the plain Git clone that upstream commits are made in.
struct Incoming {
    _temp: TempDir,
    upstream: std::path::PathBuf,
    root: std::path::PathBuf,
    owner: FolderOwner,
}

fn incoming(label: &str) -> Incoming {
    let temp = TempDir::new(label);
    let bare = temp.folder("remote.git");
    git(
        &bare,
        &["init", "--quiet", "--bare", "--initial-branch=main"],
    );
    // Another program's clone: plain Git, so it can commit what the owner
    // itself would refuse to.
    let upstream = temp.folder("upstream");
    git(&upstream, &["init", "--quiet", "--initial-branch=main"]);
    git(
        &upstream,
        &["remote", "add", "origin", &bare.display().to_string()],
    );
    std::fs::create_dir_all(upstream.join("rec/nested")).unwrap();
    std::fs::write(upstream.join("rec/take.wav"), "RIFF real audio bytes").unwrap();
    std::fs::write(upstream.join("rec/nested/deep.wav"), "RIFF deeper audio").unwrap();
    std::fs::write(upstream.join("notes.md"), "line one\nline two\n").unwrap();
    git(&upstream, &["add", "--all"]);
    git(&upstream, &["commit", "--quiet", "-m", "audio"]);
    git(&upstream, &["push", "--quiet", "origin", "main"]);

    let root = temp.folder("local");
    let owner = with_remote(&root, &bare, false);
    owner.fetch().unwrap();
    assert!(matches!(
        owner.pull_fast_forward(),
        Ok(PullOutcome::FastForwarded { .. })
    ));
    Incoming {
        _temp: temp,
        upstream,
        root,
        owner,
    }
}

impl Incoming {
    /// Commit the upstream working tree and make it the fetched head.
    fn publish(&self, message: &str) -> String {
        git(&self.upstream, &["add", "--all"]);
        git(&self.upstream, &["commit", "--quiet", "-m", message]);
        git(&self.upstream, &["push", "--quiet", "origin", "main"]);
        self.owner.fetch().unwrap().oid.unwrap()
    }

    /// The fast-forward is refused for `path` and nothing at all changed:
    /// no working file, no index entry, no ref.
    fn refused_untouched(&self, path: &str, reason_holds: &str) {
        let head = git(&self.root, &["rev-parse", "HEAD"]);
        let before = tree(&self.root);
        let refused = self.owner.pull_fast_forward().unwrap_err();
        let PullError::Unrepresentable { paths, reason } = &refused else {
            panic!("the incoming commit is unrepresentable, not {refused:?}");
        };
        assert_eq!(paths, &vec![path.to_string()]);
        assert!(reason.contains(reason_holds), "{reason}");
        assert_eq!(git(&self.root, &["rev-parse", "HEAD"]), head);
        assert_eq!(
            git(
                &self.root,
                &["--no-optional-locks", "status", "--porcelain"]
            ),
            ""
        );
        let after = tree(&self.root);
        let changed: Vec<&String> = before
            .iter()
            .zip(&after)
            .filter(|(a, b)| a != b)
            .map(|(a, _)| &a.0)
            // The fetch itself records the remote head and its objects.
            .filter(|name| {
                !name.starts_with(".git/objects")
                    && !name.starts_with(".git/refs/remotes")
                    && !name.starts_with(".git/logs/refs/remotes")
                    && *name != ".git/FETCH_HEAD"
            })
            .collect();
        assert!(changed.is_empty(), "{changed:?}");
        assert_eq!(
            std::fs::read_to_string(self.root.join("rec/take.wav")).unwrap(),
            "RIFF real audio bytes",
            "the current audio is still the audio"
        );
    }
}

#[test]
fn an_incoming_commit_that_declares_an_lfs_filter_is_refused_before_any_write() {
    // At the root: the remote starts tracking audio with LFS and replaces the
    // bytes with a pointer.
    let rooted = incoming("lfs-root");
    std::fs::write(
        rooted.upstream.join(".gitattributes"),
        "*.wav filter=lfs diff=lfs merge=lfs -text\n",
    )
    .unwrap();
    std::fs::write(rooted.upstream.join("rec/take.wav"), LFS_POINTER).unwrap();
    rooted.publish("track audio with lfs");
    rooted.refused_untouched("rec/nested/deep.wav", "filter=lfs");
    assert!(!rooted.root.join(".gitattributes").exists());

    // In a nested `.gitattributes`, selecting only files below it.
    let nested = incoming("lfs-nested");
    std::fs::write(
        nested.upstream.join("rec/nested/.gitattributes"),
        "deep.wav filter=lfs\n",
    )
    .unwrap();
    std::fs::write(nested.upstream.join("rec/nested/deep.wav"), LFS_POINTER).unwrap();
    nested.publish("track one nested file with lfs");
    nested.refused_untouched("rec/nested/deep.wav", "filter=lfs");
    assert_eq!(
        std::fs::read_to_string(nested.root.join("rec/nested/deep.wav")).unwrap(),
        "RIFF deeper audio"
    );
}

#[test]
fn an_incoming_normalizing_attribute_is_refused_even_when_it_only_selects_unchanged_files() {
    // Line-ending conversion declared for a file the commit does not touch.
    let converting = incoming("incoming-eol");
    std::fs::write(
        converting.upstream.join(".gitattributes"),
        "*.md text eol=crlf\n",
    )
    .unwrap();
    converting.publish("normalize markdown line endings");
    converting.refused_untouched("notes.md", "text");

    // The working tree's own attributes do not mask the incoming commit's:
    // locally the file is declared plain, upstream declares a filter.
    let masked = incoming("incoming-masked");
    std::fs::write(masked.root.join(".git/info/exclude"), ".gitattributes\n").unwrap();
    std::fs::write(masked.upstream.join(".gitattributes"), "*.wav filter=lfs\n").unwrap();
    masked.publish("filter audio");
    std::fs::write(masked.root.join(".gitattributes"), "*.wav -filter\n").unwrap();
    let refused = masked.owner.pull_fast_forward().unwrap_err();
    assert!(
        matches!(refused, PullError::Unrepresentable { ref reason, .. } if reason.contains("filter=lfs")),
        "{refused:?}"
    );
    assert_eq!(
        std::fs::read_to_string(masked.root.join("rec/take.wav")).unwrap(),
        "RIFF real audio bytes"
    );
}

#[test]
fn pointer_shaped_text_with_no_declared_filter_fast_forwards_byte_for_byte() {
    let plain = incoming("pointer-text");
    // Someone keeps an LFS pointer as an ordinary file, and declares
    // attributes that change no bytes.
    std::fs::write(plain.upstream.join("rec/take.wav"), LFS_POINTER).unwrap();
    std::fs::write(plain.upstream.join("example-pointer.txt"), LFS_POINTER).unwrap();
    std::fs::write(
        plain.upstream.join(".gitattributes"),
        "*.wav -text diff=audio\n*.md linguist-documentation\n",
    )
    .unwrap();
    let head = plain.publish("keep a pointer as plain text");

    assert!(matches!(
        plain.owner.pull_fast_forward(),
        Ok(PullOutcome::FastForwarded { ref to, ref changed_paths, .. })
            if *to == head && changed_paths.len() == 3
    ));
    for path in ["rec/take.wav", "example-pointer.txt"] {
        assert_eq!(
            std::fs::read_to_string(plain.root.join(path)).unwrap(),
            LFS_POINTER,
            "{path}"
        );
    }
    assert_eq!(git(&plain.root, &["rev-parse", "HEAD"]), head);
    assert_eq!(git(&plain.root, &["status", "--porcelain"]), "");
}

#[test]
fn remote_operations_without_a_remote_say_so() {
    let temp = TempDir::new("no-remote");
    let root = temp.folder("notes");
    let owner = manual(&root);
    assert_eq!(owner.push(None), PushOutcome::NoRemote);
    assert_eq!(owner.fetch(), Err(GitError::NoRemote));
    assert_eq!(
        owner.pull_fast_forward(),
        Err(PullError::Git {
            error: GitError::NoRemote
        })
    );
}

#[test]
fn an_unreachable_remote_fails_the_push_and_the_fetch_but_not_the_commit() {
    let temp = TempDir::new("bad-remote");
    let root = temp.folder("notes");
    let missing = temp.path().join("no-such-remote.git");
    let owner = with_remote(&root, &missing, true);
    save(&owner, "a.md", "A");
    eventually("the push attempt to settle", || {
        owner.snapshot().last_push.is_some()
    });
    assert_eq!(subjects(&root), vec!["Add a.md"]);
    assert!(matches!(
        owner.snapshot().last_push.as_ref().unwrap().result,
        PushOutcome::Failed { .. }
    ));
    assert!(
        matches!(owner.fetch(), Err(GitError::Failed { ref operation, .. }) if operation == "fetch")
    );
}

// ============================================================================
// Shutdown
// ============================================================================

#[test]
fn shutdown_fences_new_work_and_drains_a_held_save_and_its_commit() {
    let temp = TempDir::new("shutdown");
    let root = temp.folder("notes");
    let owner = open(&root);
    let (admitted, at_admission) = mpsc::channel::<()>();
    let (release, gate) = mpsc::channel::<()>();
    let gate = Mutex::new(gate);
    owner.hooks().before_apply = Some(Arc::new(move || {
        admitted.send(()).unwrap();
        gate.lock().unwrap().recv().unwrap();
    }));
    let saver = owner.clone();
    let held = std::thread::spawn(move || {
        saver.apply(
            &[write(
                "held.md",
                "admitted before shutdown",
                FileExpectation::Absent,
            )],
            None,
        )
    });
    at_admission.recv().unwrap();

    let closing = owner.clone();
    let (closed, finished) = mpsc::channel();
    let shutdown = std::thread::spawn(move || {
        closing.shutdown();
        closed.send(()).unwrap();
    });
    eventually("the fence", || owner.snapshot().closed);
    owner.hooks().before_apply = None;
    assert!(matches!(
        owner.apply(
            &[write("late.md", "refused", FileExpectation::Absent)],
            None
        ),
        Err(crate::files::ApplyError::Refused {
            error: crate::files::FileError::Closed
        })
    ));
    assert_eq!(owner.paths(), Err(GitError::Closed));
    assert!(owner.lease().is_err());
    assert!(
        finished.recv_timeout(Duration::from_millis(150)).is_err(),
        "shutdown waits for the admitted save"
    );

    release.send(()).unwrap();
    held.join().unwrap().unwrap();
    shutdown.join().unwrap();
    assert_eq!(
        subjects(&root),
        vec!["Add held.md"],
        "the held save was committed before shutdown returned"
    );
    assert!(!root.join("late.md").exists());
    assert_eq!(owner.commit().outcome, CommitOutcome::Closed);
    assert_eq!(owner.status(), Err(GitError::Closed));
    owner.shutdown();
}

#[cfg(unix)]
#[test]
fn a_published_commit_survives_a_failed_observation_after_the_root_moves() {
    use std::os::unix::fs::PermissionsExt;

    let temp = TempDir::new("post-publication-observation");
    let root = temp.folder("notes");
    let moved_root = temp.path().join("notes-moved");
    let owner = manual(&root);
    save(&owner, "saved.md", "published bytes");
    owner.status().unwrap();
    // Plain Git invokes this after committing the ref transaction. Moving
    // the root then makes the owner's later Git process fail to start in its
    // recorded directory, while the ref and saved file already exist.
    let hook = root.join(".git/hooks/reference-transaction");
    std::fs::write(
        &hook,
        "#!/bin/sh\nif [ \"$1\" = committed ]; then mv \"$PWD\" \"$PWD-moved\"; fi\n",
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    let pass = owner.commit();
    let snapshot = owner.snapshot();
    assert!(
        moved_root.is_dir(),
        "the Git transaction hook moved the root after publication"
    );
    let published = git(&moved_root, &["rev-parse", "HEAD"]);
    assert_eq!(
        std::fs::read_to_string(moved_root.join("saved.md")).unwrap(),
        "published bytes"
    );
    std::fs::remove_file(moved_root.join(".git/hooks/reference-transaction")).unwrap();
    std::fs::rename(&moved_root, &root).unwrap();
    owner.shutdown();
    assert!(
        matches!(pass.outcome, CommitOutcome::Committed { ref oid, .. } if oid == &published),
        "{pass:?}"
    );
    assert!(
        matches!(&snapshot.files, Observation::Observed { stale: true, error: Some(error), .. } if error.contains("could not start"))
    );
    assert!(
        matches!(&snapshot.last_commit.as_ref().unwrap().result, CommitOutcome::Committed { oid, .. } if oid == &published)
    );
}

#[cfg(unix)]
#[test]
fn a_published_fast_forward_survives_a_failed_observation_after_the_root_moves() {
    use std::os::unix::fs::PermissionsExt;

    let incoming = incoming("post-pull-observation");
    let from = git(&incoming.root, &["rev-parse", "HEAD"]);
    std::fs::write(incoming.upstream.join("notes.md"), "incoming bytes").unwrap();
    let to = incoming.publish("update the notes");
    incoming.owner.status().unwrap();
    let moved_root = incoming.root.with_file_name("local-moved");
    let hook = incoming.root.join(".git/hooks/reference-transaction");
    std::fs::write(
        &hook,
        "#!/bin/sh\nif [ \"$1\" = committed ]; then mv \"$PWD\" \"$PWD-moved\"; fi\n",
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    let outcome = incoming.owner.pull_fast_forward();
    let snapshot = incoming.owner.snapshot();
    assert!(
        moved_root.is_dir(),
        "the ref was published before the root moved"
    );
    assert_eq!(git(&moved_root, &["rev-parse", "HEAD"]), to);
    assert_eq!(
        std::fs::read_to_string(moved_root.join("notes.md")).unwrap(),
        "incoming bytes"
    );
    std::fs::remove_file(moved_root.join(".git/hooks/reference-transaction")).unwrap();
    std::fs::rename(&moved_root, &incoming.root).unwrap();
    incoming.owner.shutdown();
    assert_eq!(
        outcome,
        Ok(PullOutcome::FastForwarded {
            from: Some(from),
            to,
            changed_paths: vec!["notes.md".to_string()]
        })
    );
    assert!(
        matches!(&snapshot.files, Observation::Observed { stale: true, error: Some(error), .. } if error.contains("could not start"))
    );
    assert_eq!(snapshot.last_pull.as_ref().unwrap().result, outcome.into());
}
