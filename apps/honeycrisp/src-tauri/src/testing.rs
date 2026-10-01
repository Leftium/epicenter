//! Temporary directories and a real `git` for this crate's tests.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

/// A directory removed when the test ends.
pub struct TempDirectory(PathBuf);

impl TempDirectory {
    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A new directory, as its canonical path: `/tmp` is a link on macOS, and a
/// shell's `pwd -P` reports where the link leads.
pub fn temp(label: &str) -> TempDirectory {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let path = std::env::temp_dir().join(format!(
        "honeycrisp-shell-{label}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).unwrap();
    TempDirectory(std::fs::canonicalize(path).unwrap())
}

/// Run `git` in `root` with a fixed identity and no personal configuration.
/// Returns its trimmed output.
pub fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(root)
        .args([
            "-c",
            "user.name=Test Author",
            "-c",
            "user.email=test@example.com",
        ])
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .expect("git runs");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

/// A repository on `main` whose `notes/a.md` has two commits.
pub fn repository(label: &str) -> TempDirectory {
    let directory = temp(label);
    let root = directory.path();
    git(root, &["init", "--quiet", "--initial-branch=main"]);
    std::fs::create_dir(root.join("notes")).unwrap();
    std::fs::write(root.join("notes/a.md"), "first\n").unwrap();
    git(root, &["add", "--all"]);
    git(root, &["commit", "--quiet", "--message", "Add notes/a.md"]);
    std::fs::write(root.join("notes/a.md"), "second\n").unwrap();
    git(
        root,
        &[
            "commit",
            "--quiet",
            "--all",
            "--message",
            "Update notes/a.md",
        ],
    );
    directory
}
