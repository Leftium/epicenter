//! Open the notes directory in the system file manager.
//!
//! The directory is the root the shell registered. The page asks for it to be
//! revealed and names no path.

use std::path::Path;
use std::process::{Command, Stdio};

/// The program that opens a directory on this platform.
const OPENER: &str = if cfg!(target_os = "macos") {
    "open"
} else if cfg!(windows) {
    "explorer"
} else {
    "xdg-open"
};

/// Start the file manager on `root`. Returns once it has started, without
/// waiting for it; an error says why it could not start.
pub fn reveal(root: &Path) -> Result<(), String> {
    reveal_with(OPENER, root)
}

/// `reveal` with the opener named, so a test can use a program that is safe
/// to run.
pub fn reveal_with(opener: &str, root: &Path) -> Result<(), String> {
    let mut child = Command::new(opener)
        .arg(root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|cause| format!("{opener} could not start: {cause}"))?;
    // Reap it when it ends, so it does not linger as a finished process.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::testing::temp;
    use std::time::{Duration, Instant};

    #[test]
    fn the_opener_receives_the_root_as_its_only_argument() {
        let directory = temp("reveal");
        // `mkdir` stands in for the file manager: it makes exactly what it is given.
        let root = directory.path().join("-notes with spaces");
        reveal_with("mkdir", &root).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !root.is_dir() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(root.is_dir());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn an_opener_that_cannot_start_is_reported() {
        let directory = temp("reveal-missing");
        let problem = reveal_with("honeycrisp-no-such-opener", directory.path()).unwrap_err();
        assert!(
            problem.starts_with("honeycrisp-no-such-opener could not start: "),
            "{problem}"
        );
    }
}
