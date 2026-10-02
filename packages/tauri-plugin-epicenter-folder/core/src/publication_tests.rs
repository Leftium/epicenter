//! File publication through one owner.
//!
//! Every window's saves go through the same owner, so these tests use several
//! handles to one `FolderOwner` the way several windows would.
//!
//! Key behaviors:
//! - Two saves conditional on the same version: exactly one lands.
//! - Private Git state, traversal, and symbolic links are refused before
//!   anything outside the folder is touched.
//! - A batch that stops partway keeps its landed prefix and attempts no commit.
//! - A change made outside the owner marks history stale and tells listeners;
//!   it starts no commit and no scan.
//! - Exclusive creation and moves never replace an existing file.
//! - Nothing holds the folder between one caller's calls: a write built on an
//!   earlier read is refused once another caller wrote in between.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::files::{ApplyError, FileChange, FileError, FileExpectation, FileStep, FileVersion};
use crate::history::{Observation, OwnerEvent};
use crate::owner::{FolderConfig, FolderOwner};
use crate::testing::{config, eventually, git, open, write, TempDir};

/// Wait for the commit a save was admitted for, if it was. The save decided
/// that before it returned, so nothing can start after this sees it idle.
fn settled(owner: &FolderOwner) {
    eventually("the admitted commit to finish", || {
        !owner.snapshot().activity.commit.active
    });
}

fn manual(root: &std::path::Path) -> FolderOwner {
    FolderOwner::open(FolderConfig {
        commit_on_edit: false,
        ..config(root)
    })
    .expect("open the folder")
}

#[test]
fn two_saves_conditional_on_one_version_land_exactly_once() {
    let temp = TempDir::new("conflict");
    let root = temp.folder("notes");
    let owner = manual(&root);
    owner
        .apply(&[write("a.md", "base", FileExpectation::Absent)])
        .unwrap();
    let base = owner.read("a.md").unwrap().version;

    let results: Vec<Result<(), ApplyError>> = std::thread::scope(|scope| {
        let saves: Vec<_> = ["from window A", "from window B"]
            .into_iter()
            .map(|content| {
                let window = owner.clone();
                let expected = FileExpectation::version(&base);
                scope.spawn(move || window.apply(&[write("a.md", content, expected)]))
            })
            .collect();
        saves.into_iter().map(|save| save.join().unwrap()).collect()
    });

    let landed: Vec<_> = results.iter().filter(|result| result.is_ok()).collect();
    assert_eq!(landed.len(), 1, "{results:?}");
    let refused = results
        .iter()
        .find_map(|result| result.as_ref().err())
        .unwrap();
    let ApplyError::Refused {
        error:
            FileError::Conflict {
                path,
                expected,
                actual,
            },
    } = refused
    else {
        panic!("the losing save is a conflict, not {refused:?}");
    };
    assert_eq!(path, "a.md");
    assert_eq!(*expected, FileExpectation::version(&base));
    let current = owner.read("a.md").unwrap();
    assert_eq!(actual.as_ref(), Some(&current.version));
    assert!(current.bytes.starts_with(b"from window "));
}

#[cfg(unix)]
#[test]
fn private_git_traversal_and_links_are_refused_and_outside_files_untouched() {
    let temp = TempDir::new("escape");
    let root = temp.folder("notes");
    let outside = temp.folder("outside");
    std::fs::write(outside.join("sentinel.txt"), "untouched").unwrap();
    let owner = manual(&root);
    std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
    std::os::unix::fs::symlink(outside.join("sentinel.txt"), root.join("alias.txt")).unwrap();
    let config_before = std::fs::read(root.join(".git/config")).unwrap();

    let invalid = |path: &str, reason: &str| {
        for change in [
            write(path, "x", FileExpectation::Any),
            FileChange::Remove {
                path: path.to_string(),
                expected: FileExpectation::Any,
            },
            FileChange::Move {
                from: "a.md".to_string(),
                to: path.to_string(),
                expected: FileExpectation::Any,
            },
        ] {
            assert_eq!(
                owner.apply(&[change]),
                Err(ApplyError::Refused {
                    error: FileError::InvalidPath {
                        path: path.to_string(),
                        reason: reason.to_string(),
                    }
                }),
                "{path}"
            );
        }
        assert!(
            matches!(owner.read(path), Err(FileError::InvalidPath { .. })),
            "{path}"
        );
        assert!(
            matches!(owner.mkdir(path), Err(FileError::InvalidPath { .. })),
            "{path}"
        );
        assert!(
            matches!(owner.rmdir(path), Err(FileError::InvalidPath { .. })),
            "{path}"
        );
    };
    invalid(
        "../outside/sentinel.txt",
        "the path contains a relative segment",
    );
    invalid(
        "a/../../outside/sentinel.txt",
        "the path contains a relative segment",
    );
    invalid(".git/config", "the path is inside private Git state");
    invalid("sub/.GIT/config", "the path is inside private Git state");
    invalid("/etc/hosts", "the path must be folder-relative");
    invalid("a\\b", "the path contains a backslash");
    let absolute = outside.join("sentinel.txt").display().to_string();
    invalid(&absolute, "the path must be folder-relative");

    let through_link = "the path passes through a symbolic link";
    for path in ["link/sentinel.txt", "link/new.txt", "alias.txt"] {
        let error = owner
            .apply(&[write(path, "x", FileExpectation::Any)])
            .unwrap_err();
        assert_eq!(
            error,
            ApplyError::Refused {
                error: FileError::InvalidPath {
                    path: path.to_string(),
                    reason: through_link.to_string(),
                }
            }
        );
        assert!(matches!(
            owner.read(path),
            Err(FileError::InvalidPath { .. })
        ));
    }
    assert!(matches!(
        owner.children("link"),
        Err(FileError::InvalidPath { .. })
    ));
    assert!(matches!(
        owner.mkdir("link/sub"),
        Err(FileError::InvalidPath { .. })
    ));

    assert_eq!(
        std::fs::read_to_string(outside.join("sentinel.txt")).unwrap(),
        "untouched"
    );
    assert_eq!(
        std::fs::read_dir(&outside).unwrap().count(),
        1,
        "nothing was created outside the folder"
    );
    assert_eq!(
        std::fs::read(root.join(".git/config")).unwrap(),
        config_before
    );
    let listing = owner.list().unwrap();
    assert!(
        listing.files.is_empty(),
        "links are not listed: {listing:?}"
    );
}

#[cfg(unix)]
#[test]
fn a_linked_git_directory_or_scratch_directory_refuses_to_open() {
    let temp = TempDir::new("layout");
    let elsewhere = temp.folder("elsewhere");
    git(&elsewhere, &["init", "--quiet"]);

    let linked = temp.folder("linked");
    std::os::unix::fs::symlink(elsewhere.join(".git"), linked.join(".git")).unwrap();
    let error = FolderOwner::open(config(&linked)).err().unwrap();
    assert!(error.contains(".git is a symbolic link"), "{error}");

    let worktree = temp.folder("worktree");
    std::fs::write(worktree.join(".git"), "gitdir: ../elsewhere/.git\n").unwrap();
    let error = FolderOwner::open(config(&worktree)).err().unwrap();
    assert!(error.contains("points at another Git directory"), "{error}");

    let scratch = temp.folder("scratch");
    git(&scratch, &["init", "--quiet"]);
    std::fs::create_dir(scratch.join(".git/epicenter")).unwrap();
    std::os::unix::fs::symlink(&elsewhere, scratch.join(".git/epicenter/scratch")).unwrap();
    let error = FolderOwner::open(config(&scratch)).err().unwrap();
    assert!(
        error.contains(".git/epicenter/scratch is a symbolic link"),
        "{error}"
    );
}

#[test]
fn a_partial_batch_keeps_its_prefix_and_attempts_no_commit_until_a_complete_save() {
    let temp = TempDir::new("partial");
    let root = temp.folder("notes");
    let owner = open(&root);
    owner
        .apply(&[write("b.md", "theirs", FileExpectation::Absent)])
        .unwrap();
    settled(&owner);
    let head = git(&root, &["rev-parse", "HEAD"]);
    owner.status().unwrap();

    let result = owner.apply(&[
        write("a.md", "first", FileExpectation::Absent),
        write("b.md", "mine", FileExpectation::Absent),
        write("c.md", "never", FileExpectation::Absent),
    ]);
    let Err(ApplyError::Partial {
        applied,
        failed,
        error,
        not_attempted,
    }) = result
    else {
        panic!("the batch stopped partway: {result:?}");
    };
    assert_eq!(
        applied,
        vec![FileStep::Write {
            path: "a.md".into()
        }]
    );
    assert_eq!(
        failed,
        FileStep::Write {
            path: "b.md".into()
        }
    );
    assert!(matches!(error, FileError::Conflict { .. }));
    assert_eq!(
        not_attempted,
        vec![FileStep::Write {
            path: "c.md".into()
        }]
    );
    assert_eq!(owner.read("a.md").unwrap().bytes, b"first");
    assert_eq!(owner.read("b.md").unwrap().bytes, b"theirs");
    assert!(matches!(
        owner.read("c.md"),
        Err(FileError::NotFound { .. })
    ));

    // The landed prefix invalidates the observation but is not committed: a
    // partial batch makes no attempt, so there is nothing to wait for.
    assert!(!owner.snapshot().activity.commit.active);
    assert_eq!(git(&root, &["rev-parse", "HEAD"]), head);
    let Observation::Observed { stale, .. } = &owner.snapshot().files else {
        panic!("the earlier status is still the observation");
    };
    assert!(*stale);

    owner
        .apply(&[write("c.md", "complete", FileExpectation::Absent)])
        .unwrap();
    settled(&owner);
    assert_eq!(git(&root, &["log", "-1", "--format=%s"]), "Update 2 files");
    assert_eq!(git(&root, &["show", "HEAD:a.md"]), "first");
}

#[test]
fn exclusive_creation_and_moves_never_replace_an_existing_file() {
    let temp = TempDir::new("exclusive");
    let root = temp.folder("notes");
    let owner = manual(&root);
    owner
        .apply(&[write("a.md", "a", FileExpectation::Absent)])
        .unwrap();
    owner
        .apply(&[write("b.md", "b", FileExpectation::Absent)])
        .unwrap();

    let again = owner.apply(&[write("a.md", "again", FileExpectation::Absent)]);
    assert!(matches!(
        again,
        Err(ApplyError::Refused { error: FileError::Conflict { ref actual, .. } })
            if *actual == Some(FileVersion::of(b"a"))
    ));
    let moved = owner.apply(&[FileChange::Move {
        from: "a.md".into(),
        to: "b.md".into(),
        expected: FileExpectation::Any,
    }]);
    assert!(matches!(
        moved,
        Err(ApplyError::Refused { error: FileError::Conflict { ref path, .. } }) if path == "b.md"
    ));
    assert_eq!(owner.read("a.md").unwrap().bytes, b"a");
    assert_eq!(owner.read("b.md").unwrap().bytes, b"b");

    owner
        .apply(&[FileChange::Move {
            from: "a.md".into(),
            to: "deep/er/c.md".into(),
            expected: FileExpectation::version(&FileVersion::of(b"a")),
        }])
        .unwrap();
    assert!(matches!(
        owner.read("a.md"),
        Err(FileError::NotFound { .. })
    ));
    assert_eq!(owner.read("deep/er/c.md").unwrap().bytes, b"a");
    assert_eq!(
        owner.apply(&[FileChange::Remove {
            path: "missing.md".into(),
            expected: FileExpectation::Any,
        }]),
        Err(ApplyError::Refused {
            error: FileError::NotFound {
                path: "missing.md".into()
            }
        })
    );
}

#[test]
fn a_differently_cased_name_never_overwrites_the_existing_file() {
    let temp = TempDir::new("case");
    let root = temp.folder("notes");
    let owner = manual(&root);
    owner
        .apply(&[write("Note.md", "upper", FileExpectation::Absent)])
        .unwrap();
    let lower = owner.apply(&[write("note.md", "lower", FileExpectation::Absent)]);
    assert_eq!(owner.read("Note.md").unwrap().bytes, b"upper");
    match lower {
        // A case-sensitive filesystem holds both names.
        Ok(()) => assert_eq!(owner.read("note.md").unwrap().bytes, b"lower"),
        // A case-insensitive one refuses rather than aliasing the first.
        Err(error) => {
            assert!(matches!(
                error,
                ApplyError::Refused {
                    error: FileError::Conflict { .. }
                }
            ));
            assert!(matches!(
                owner.read("note.md"),
                Err(FileError::NotFound { .. })
            ));
        }
    }
}

#[test]
fn directory_changes_and_reads_attempt_no_commit() {
    let temp = TempDir::new("directories");
    let root = temp.folder("notes");
    let owner = open(&root);
    owner.mkdir("a/b").unwrap();
    owner.mkdir("a/b").unwrap();
    assert_eq!(owner.children("a").unwrap().directories, vec!["b"]);
    assert_eq!(owner.list().unwrap().directories, vec!["a", "a/b"]);
    assert_eq!(
        owner.rmdir("a"),
        Err(FileError::DirectoryNotEmpty { path: "a".into() })
    );
    owner.rmdir("a/b").unwrap();
    assert_eq!(
        owner.rmdir("a/b"),
        Err(FileError::NotFound { path: "a/b".into() })
    );
    let many = owner
        .read_many(&["a".to_string(), "nope.md".to_string()])
        .unwrap();
    assert_eq!(many[0], Err(FileError::NotAFile { path: "a".into() }));
    assert_eq!(
        many[1],
        Err(FileError::NotFound {
            path: "nope.md".into()
        })
    );
    let snapshot = owner.snapshot();
    assert!(snapshot.last_commit.is_none());
    assert!(!snapshot.activity.commit.active);
    assert!(!root.join(".git/refs/heads/main").exists());
}

#[test]
fn every_listener_hears_a_save_made_through_any_handle() {
    let temp = TempDir::new("events");
    let root = temp.folder("notes");
    let owner = manual(&root);
    let heard: Arc<Mutex<Vec<Vec<String>>>> = Arc::default();
    let subscriptions: Vec<_> = (0..2)
        .map(|_| {
            let heard = Arc::clone(&heard);
            owner.subscribe(move |event| {
                if let OwnerEvent::FilesChanged { paths, .. } = event {
                    heard.lock().unwrap().push(paths.clone());
                }
            })
        })
        .collect();
    owner
        .clone()
        .apply(&[write("a.md", "a", FileExpectation::Absent)])
        .unwrap();
    assert_eq!(*heard.lock().unwrap(), vec![vec!["a.md".to_string()]; 2]);

    drop(subscriptions);
    owner
        .apply(&[write("b.md", "b", FileExpectation::Absent)])
        .unwrap();
    assert_eq!(
        heard.lock().unwrap().len(),
        2,
        "a dropped subscription hears nothing"
    );
}

#[test]
fn outside_changes_are_reported_and_own_saves_are_not_mistaken_for_them() {
    let temp = TempDir::new("external");
    let root = temp.folder("notes");
    let owner = manual(&root);
    owner
        .apply(&[write("a.md", "a", FileExpectation::Absent)])
        .unwrap();
    owner.status().unwrap();
    let heard: Arc<Mutex<Vec<Vec<String>>>> = Arc::default();
    let listener = Arc::clone(&heard);
    let _subscription = owner.subscribe(move |event| {
        if let OwnerEvent::FilesChanged { paths, .. } = event {
            listener.lock().unwrap().push(paths.clone());
        }
    });

    owner.poll_external();
    assert!(
        heard.lock().unwrap().is_empty(),
        "the owner's own save is not an outside change"
    );
    assert!(matches!(
        owner.snapshot().files,
        Observation::Observed { stale: false, .. }
    ));

    std::fs::write(root.join("outside.md"), "written by another program").unwrap();
    std::fs::write(root.join("index.sqlite3"), "derived").unwrap();
    owner.poll_external();
    assert_eq!(*heard.lock().unwrap(), vec![vec!["outside.md".to_string()]]);
    assert!(matches!(
        owner.snapshot().files,
        Observation::Observed { stale: true, .. }
    ));

    owner.poll_external();
    assert_eq!(
        heard.lock().unwrap().len(),
        1,
        "an unchanged folder reports nothing"
    );
}

#[test]
fn an_outside_change_marks_history_stale_and_starts_no_commit_and_no_scan() {
    let temp = TempDir::new("external-automatic");
    let root = temp.folder("notes");
    // This folder commits on edit. Only its own complete saves attempt that.
    let owner = open(&root);
    owner
        .apply(&[write("a.md", "a", FileExpectation::Absent)])
        .unwrap();
    settled(&owner);
    owner.status().unwrap();
    let head = git(&root, &["rev-parse", "HEAD"]);
    let committed = owner.snapshot().last_commit.clone();
    let heard: Arc<Mutex<Vec<Vec<String>>>> = Arc::default();
    let listener = Arc::clone(&heard);
    let _subscription = owner.subscribe(move |event| {
        if let OwnerEvent::FilesChanged { paths, .. } = event {
            listener.lock().unwrap().push(paths.clone());
        }
    });

    std::fs::write(root.join("outside.md"), "written by another program").unwrap();
    owner.poll_external();

    // The report is made on this thread, and it is all that happens.
    assert_eq!(*heard.lock().unwrap(), vec![vec!["outside.md".to_string()]]);
    let snapshot = owner.snapshot();
    assert!(matches!(
        snapshot.files,
        Observation::Observed { stale: true, ref value, .. } if value.changes.is_empty()
    ));
    assert!(!snapshot.activity.commit.active && !snapshot.activity.scan.active);
    assert_eq!(snapshot.last_commit, committed);
    assert_eq!(git(&root, &["rev-parse", "HEAD"]), head);

    // The outside file is still there for whoever commits next.
    assert!(matches!(
        owner.commit(),
        crate::history::CommitOutcome::Committed { ref message, changed_paths: 1, .. }
            if message == "Add outside.md"
    ));
}

#[test]
fn events_for_git_objects_scratch_and_lock_files_announce_nothing() {
    let temp = TempDir::new("event-noise");
    let root = temp.folder("notes");
    let owner = manual(&root);

    owner.announce(&[
        ".git/objects/ab/cdef",
        ".git/epicenter/scratch/capture-1-0/a.md",
        ".git/logs/HEAD",
        ".git/index.lock",
        ".git/refs/heads/main.lock",
        "index.sqlite3",
        ".DS_Store",
    ]);
    assert_eq!(
        owner.announcements(),
        0,
        "the owner's own Git work wakes nothing"
    );

    owner.announce(&[".git/refs/heads/main"]);
    owner.announce(&[".git/HEAD"]);
    owner.announce(&["notes/a.md"]);
    assert_eq!(owner.announcements(), 3);
}

#[test]
fn a_filesystem_event_reports_an_edit_that_left_size_and_time_unchanged() {
    let temp = TempDir::new("events");
    let root = temp.folder("notes");
    let owner = FolderOwner::open(FolderConfig {
        commit_on_edit: false,
        watch_events: true,
        ..config(&root)
    })
    .unwrap();
    assert_eq!(
        owner.watch_diagnostic(),
        None,
        "this platform can watch the folder"
    );
    owner
        .apply(&[write("a.md", "first", FileExpectation::Absent)])
        .unwrap();
    let heard: Arc<Mutex<Vec<String>>> = Arc::default();
    let listener = Arc::clone(&heard);
    let _subscription = owner.subscribe(move |event| {
        if let OwnerEvent::FilesChanged { paths, .. } = event {
            listener.lock().unwrap().extend(paths.clone());
        }
    });

    // Straight after the owner's own save, with no pause, another program
    // rewrites the file in place: same length, and it puts the modification
    // time back. Comparing size and time cannot see this, and nothing about
    // the file says the owner did not write it.
    let file = root.join("a.md");
    let modified = std::fs::metadata(&file).unwrap().modified().unwrap();
    std::fs::write(&file, "FIRST").unwrap();
    std::fs::File::options()
        .write(true)
        .open(&file)
        .unwrap()
        .set_modified(modified)
        .unwrap();
    assert_eq!(
        std::fs::metadata(&file).unwrap().modified().unwrap(),
        modified
    );
    owner.poll_external();
    owner.status().unwrap();
    heard.lock().unwrap().clear();
    // What the watcher's callback does when the platform reports the path.
    owner.announce(&["a.md"]);

    eventually("the announced edit to be reported", || {
        heard.lock().unwrap().contains(&"a.md".to_string())
    });
    assert!(matches!(
        owner.snapshot().files,
        Observation::Observed { stale: true, .. }
    ));
    assert_eq!(owner.read("a.md").unwrap().bytes, b"FIRST");

    // Shutdown releases the watcher: later edits are heard by nobody.
    owner.shutdown();
    let before = owner.announcements();
    heard.lock().unwrap().clear();
    std::fs::write(root.join("after.md"), "written after shutdown").unwrap();
    owner.announce(&["after.md"]);
    std::thread::sleep(Duration::from_millis(1500));
    assert!(heard.lock().unwrap().is_empty());
    assert_eq!(
        owner.announcements(),
        before + 1,
        "only the direct call; the watcher is gone"
    );
}

#[test]
fn the_platform_watcher_announces_an_outside_write() {
    let temp = TempDir::new("platform-events");
    let root = temp.folder("notes");
    let owner = FolderOwner::open(FolderConfig {
        commit_on_edit: false,
        watch_events: true,
        ..config(&root)
    })
    .unwrap();
    assert_eq!(owner.watch_diagnostic(), None);
    let heard: Arc<Mutex<Vec<String>>> = Arc::default();
    let listener = Arc::clone(&heard);
    let _subscription = owner.subscribe(move |event| {
        if let OwnerEvent::FilesChanged { paths, .. } = event {
            listener.lock().unwrap().extend(paths.clone());
        }
    });
    // Give the platform a moment to start delivering for this directory.
    std::thread::sleep(Duration::from_millis(500));

    std::fs::write(root.join("outside.md"), "written by another program").unwrap();

    for _ in 0..1500 {
        if heard.lock().unwrap().contains(&"outside.md".to_string()) {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!(
        "no filesystem event reached the owner in 15 seconds ({} announcements); this environment may not deliver them",
        owner.announcements()
    );
}

#[test]
fn a_write_built_on_an_earlier_read_is_refused_once_another_caller_wrote_between_them() {
    let temp = TempDir::new("interleaved");
    let root = temp.folder("notes");
    let owner = manual(&root);
    owner
        .apply(&[write("a.md", "base", FileExpectation::Absent)])
        .unwrap();

    // One caller's command reads, and makes a directory, as a terminal's
    // steps do. Nothing holds the folder between its calls.
    let command = owner.clone();
    let read = command.read("a.md").unwrap().version;
    command.mkdir("made").unwrap();

    // Another caller's save lands between that command's steps.
    let other = owner.clone();
    other
        .apply(&[write("a.md", "from another window", FileExpectation::Any)])
        .unwrap();
    let theirs = owner.read("a.md").unwrap().version;

    // The command's rewrite carries the version it read, and is refused. The
    // step before it landed and is reported; nothing is rolled back.
    assert_eq!(
        command.apply(&[
            write("b.md", "its unconditional step lands", FileExpectation::Any),
            write("a.md", "built on the read", FileExpectation::version(&read)),
            write("c.md", "never attempted", FileExpectation::Absent),
        ]),
        Err(ApplyError::Partial {
            applied: vec![FileStep::Write {
                path: "b.md".into()
            }],
            failed: FileStep::Write {
                path: "a.md".into()
            },
            error: FileError::Conflict {
                path: "a.md".into(),
                expected: FileExpectation::version(&read),
                actual: Some(theirs.clone()),
            },
            not_attempted: vec![FileStep::Write {
                path: "c.md".into()
            }],
        })
    );
    assert_eq!(owner.read("a.md").unwrap().bytes, b"from another window");
    // Built on what is there now, it lands.
    command
        .apply(&[write(
            "a.md",
            "built on theirs",
            FileExpectation::version(&theirs),
        )])
        .unwrap();
    assert_eq!(owner.read("a.md").unwrap().bytes, b"built on theirs");
}
