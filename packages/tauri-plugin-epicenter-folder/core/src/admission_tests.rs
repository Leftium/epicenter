//! Opening only an existing repository: what counts as one, and that an
//! owner told to require one refuses, under the folder's lock, instead of
//! initializing new history in whatever directory it was given.

use std::fs;

use crate::files::has_repository;
use crate::owner::{FolderConfig, FolderOwner};
use crate::registry::{AttachError, Registry, ScopeConfig};
use crate::testing::{config, git, tree, TempDir};

fn requiring(root: &std::path::Path) -> FolderConfig {
    FolderConfig {
        require_existing_repository: true,
        ..config(root)
    }
}

#[test]
fn a_repository_is_a_real_git_directory_with_head_objects_and_refs() {
    let temp = TempDir::new("admission-criterion");
    let root = temp.folder("folder");
    assert!(!has_repository(&root).unwrap(), "no .git");
    fs::create_dir(root.join(".git")).unwrap();
    assert!(!has_repository(&root).unwrap(), "an empty .git");
    fs::write(root.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
    assert!(!has_repository(&root).unwrap(), "HEAD alone");
    fs::remove_dir_all(root.join(".git")).unwrap();

    // `git init`: an unborn main, as an empty download leaves it.
    git(&root, &["init", "--quiet", "--initial-branch=main"]);
    assert!(has_repository(&root).unwrap());

    let pointer = temp.folder("worktree");
    fs::write(pointer.join(".git"), "gitdir: /elsewhere\n").unwrap();
    assert!(!has_repository(&pointer).unwrap(), "a .git file");
    #[cfg(unix)]
    {
        let linked = temp.folder("linked");
        std::os::unix::fs::symlink(root.join(".git"), linked.join(".git")).unwrap();
        assert!(!has_repository(&linked).unwrap(), "a linked .git");
    }
}

#[test]
fn an_owner_that_requires_a_repository_creates_nothing_where_there_is_none() {
    let temp = TempDir::new("admission-refused");
    let empty = temp.folder("empty");
    let with_files = temp.folder("files");
    fs::write(with_files.join("note.md"), "mine").unwrap();
    let empty_git = temp.folder("empty-git");
    fs::create_dir(empty_git.join(".git")).unwrap();
    for root in [&empty, &with_files, &empty_git] {
        let before = tree(root);
        let directories_before = fs::read_dir(root).unwrap().count();
        let error = FolderOwner::open(requiring(root)).err().expect("refused");
        assert!(error.contains("is not a Git repository"), "{error}");
        assert!(error.contains("move them aside"), "{error}");
        assert_eq!(tree(root), before);
        assert_eq!(fs::read_dir(root).unwrap().count(), directories_before);
        if root == &empty_git {
            assert_eq!(fs::read_dir(root.join(".git")).unwrap().count(), 0);
        }
    }
    // Without the requirement, opening still initializes, as before.
    let owner = FolderOwner::open(config(&empty)).unwrap();
    assert!(has_repository(&empty).unwrap());
    owner.shutdown();
}

#[test]
fn an_owner_that_requires_a_repository_opens_an_unborn_or_committed_one() {
    let temp = TempDir::new("admission-opened");
    let unborn = temp.folder("unborn");
    git(&unborn, &["init", "--quiet", "--initial-branch=main"]);
    let owner = FolderOwner::open(requiring(&unborn)).unwrap();
    owner.apply(&[crate::testing::create("a.md", "a")]).unwrap();
    owner.shutdown();
    assert_eq!(fs::read_to_string(unborn.join("a.md")).unwrap(), "a");
}

/// The check is the owner's, behind the registry's lock: a scope registered
/// while its `.git` existed, which then went missing, still refuses on attach.
#[test]
fn a_repository_that_disappears_before_attach_is_refused_under_the_lock() {
    let temp = TempDir::new("admission-late");
    let root = temp.folder("folder");
    git(&root, &["init", "--quiet", "--initial-branch=main"]);
    let registry = Registry::new();
    registry
        .register(ScopeConfig {
            scope: "com.example.notes".into(),
            folder: requiring(&root),
            windows: vec!["app".into()],
        })
        .unwrap();
    fs::remove_dir_all(root.join(".git")).unwrap();
    let refusal = registry.attach("com.example.notes", "app").err().unwrap();
    let AttachError::Unavailable { message } = refusal else {
        panic!("unavailable, not {refusal:?}");
    };
    assert!(message.contains("is not a Git repository"), "{message}");
    assert!(!root.join(".git").exists());
    registry.shutdown();
}
