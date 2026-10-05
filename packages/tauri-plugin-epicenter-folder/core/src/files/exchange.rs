//! Atomic exchange of two existing directory entries, so a replacement lands
//! only on a file that is still there when it lands.
//!
//! macOS and iOS: `renamex_np(RENAME_SWAP)`. Linux and Android:
//! `renameat2(RENAME_EXCHANGE)`, through `syscall(2)` so no particular C
//! library version is required. Both paths must exist when the call runs:
//! when either is missing it fails with `NotFound` and neither path changes.
//! A filesystem that cannot exchange fails with its own error; nothing falls
//! back to a rename.
//!
//! Every other target, Windows included, fails here with `Unsupported`
//! before touching either path, using only the standard library (`libc` is
//! a Unix-only dependency). A replacement there is an `Io` failure with
//! nothing written, unavailable until a mechanism that requires the file at
//! publication is proven; nothing else is claimed for those targets.

use std::io;
use std::path::Path;

/// Swap the entries at `a` and `b`, both of which must exist.
#[cfg(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "linux",
    target_os = "android"
))]
pub(super) fn exchange(a: &Path, b: &Path) -> io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let a = CString::new(a.as_os_str().as_bytes())?;
    let b = CString::new(b.as_os_str().as_bytes())?;
    if swap(&a, &b) == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn swap(a: &std::ffi::CStr, b: &std::ffi::CStr) -> libc::c_int {
    // SAFETY: both pointers are NUL-terminated paths that outlive the call.
    unsafe { libc::renamex_np(a.as_ptr(), b.as_ptr(), libc::RENAME_SWAP) }
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn swap(a: &std::ffi::CStr, b: &std::ffi::CStr) -> libc::c_int {
    /// `linux/fs.h`; the kernel ABI value, defined here so an older C
    /// library's headers do not matter.
    const RENAME_EXCHANGE: libc::c_uint = 1 << 1;
    // SAFETY: both pointers are NUL-terminated paths that outlive the call,
    // and the arguments match renameat2(2).
    unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            libc::AT_FDCWD,
            a.as_ptr(),
            libc::AT_FDCWD,
            b.as_ptr(),
            RENAME_EXCHANGE,
        ) as libc::c_int
    }
}

#[cfg(not(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "linux",
    target_os = "android"
)))]
pub(super) fn exchange(_a: &Path, _b: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        format!(
            "replace-existing publication is not available on {}. Nothing was written to the destination.",
            std::env::consts::OS
        ),
    ))
}

#[cfg(all(
    test,
    not(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "linux",
        target_os = "android"
    ))
))]
mod unsupported_tests {
    //! Where there is no exchange, a replacement is refused and the file stays.

    use std::fs;

    use crate::files::{sha256, ApplyError, FileChange, FileError, Files};
    use crate::testing::TempDir;

    #[test]
    fn a_replacement_is_io_and_writes_nothing() {
        let temp = TempDir::new("exchange-unsupported");
        let root = temp.folder("unsupported");
        fs::write(root.join("note.md"), "read").unwrap();

        let result = Files::new(&root).apply(&[FileChange::Replace {
            path: "note.md".to_string(),
            bytes: b"mine".to_vec(),
            expected_sha256: Some(sha256(b"read")),
        }]);

        let Err(ApplyError::Refused {
            error: FileError::Io { cause, .. },
        }) = result.clone()
        else {
            panic!("a refused replacement, not {result:?}");
        };
        assert!(cause.contains(std::env::consts::OS), "{cause}");
        assert_eq!(fs::read_to_string(root.join("note.md")).unwrap(), "read");
        assert_eq!(
            fs::read_dir(root.join(".git/epicenter/scratch"))
                .unwrap()
                .count(),
            0
        );
    }
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod tests {
    //! The exchange against the real filesystem, and a replacement's outcome
    //! when another program acts just before or just after it: a file
    //! removed is not put back, and a displaced entry that is not a regular
    //! file is kept where the exchange left it, with nothing touching the
    //! path again.

    use std::fs;
    use std::io::ErrorKind;
    use std::path::{Path, PathBuf};

    use super::exchange;
    use crate::files::{
        sha256, ApplyError, FileChange, FileError, FileStep, Files, AFTER_EXCHANGE, BEFORE_EXCHANGE,
    };
    use crate::testing::TempDir;

    #[test]
    fn two_existing_files_trade_places() {
        let temp = TempDir::new("exchange-swap");
        let root = temp.folder("swap");
        fs::write(root.join("a"), "A").unwrap();
        fs::write(root.join("b"), "B").unwrap();

        exchange(&root.join("a"), &root.join("b")).unwrap();

        assert_eq!(fs::read_to_string(root.join("a")).unwrap(), "B");
        assert_eq!(fs::read_to_string(root.join("b")).unwrap(), "A");
    }

    #[test]
    fn a_missing_path_is_not_found_and_nothing_is_created() {
        let temp = TempDir::new("exchange-missing");
        let root = temp.folder("missing");
        fs::write(root.join("staged"), "new").unwrap();

        let error = exchange(&root.join("staged"), &root.join("gone")).unwrap_err();
        assert_eq!(error.kind(), ErrorKind::NotFound);
        assert!(!root.join("gone").exists());
        assert_eq!(fs::read_to_string(root.join("staged")).unwrap(), "new");

        let error = exchange(&root.join("gone"), &root.join("staged")).unwrap_err();
        assert_eq!(error.kind(), ErrorKind::NotFound);
        assert_eq!(fs::read_to_string(root.join("staged")).unwrap(), "new");
    }

    type Hook = Box<dyn Fn(&Path)>;

    /// Another program's moves just before and just after the exchange, on
    /// this test's thread, until dropped.
    struct Around;

    impl Around {
        fn new(before: Option<Hook>, after: Option<Hook>) -> Self {
            BEFORE_EXCHANGE.with(|hook| *hook.borrow_mut() = before);
            AFTER_EXCHANGE.with(|hook| *hook.borrow_mut() = after);
            Around
        }
    }

    impl Drop for Around {
        fn drop(&mut self) {
            BEFORE_EXCHANGE.with(|hook| hook.borrow_mut().take());
            AFTER_EXCHANGE.with(|hook| hook.borrow_mut().take());
        }
    }

    fn replace(path: &str, text: &str, expected: Option<&str>) -> FileChange {
        FileChange::Replace {
            path: path.to_string(),
            bytes: text.as_bytes().to_vec(),
            expected_sha256: expected.map(str::to_string),
        }
    }

    fn scratch_entries(root: &Path) -> Vec<PathBuf> {
        fs::read_dir(root.join(".git/epicenter/scratch"))
            .map(|entries| entries.flatten().map(|entry| entry.path()).collect())
            .unwrap_or_default()
    }

    /// Put a directory where the file was.
    fn directory_at(target: &Path) {
        fs::remove_file(target).unwrap();
        fs::create_dir(target).unwrap();
        fs::write(target.join("inside.md"), "kept").unwrap();
    }

    #[test]
    fn a_file_removed_after_the_check_is_not_put_back() {
        for expected in [None, Some(sha256(b"read"))] {
            let temp = TempDir::new("exchange-removed");
            let root = temp.folder("removed");
            fs::create_dir(root.join("todos")).unwrap();
            fs::write(root.join("todos/x.md"), "read").unwrap();
            let _around = Around::new(
                Some(Box::new(|target: &Path| fs::remove_file(target).unwrap())),
                None,
            );

            let result =
                Files::new(&root).apply(&[replace("todos/x.md", "mine", expected.as_deref())]);

            let error = match expected.clone() {
                None => FileError::NotFound {
                    path: "todos/x.md".to_string(),
                },
                Some(expected_sha256) => FileError::Conflict {
                    path: "todos/x.md".to_string(),
                    expected_sha256,
                    actual_sha256: None,
                },
            };
            assert_eq!(result, Err(ApplyError::Refused { error }));
            assert!(!root.join("todos/x.md").exists());
            assert_eq!(scratch_entries(&root), Vec::<PathBuf>::new());
        }
    }

    #[test]
    fn a_displaced_directory_is_kept_and_the_write_is_partial() {
        let temp = TempDir::new("exchange-directory");
        let root = temp.folder("directory");
        fs::write(root.join("note.md"), "read").unwrap();
        let _around = Around::new(Some(Box::new(directory_at)), None);
        let later = FileChange::Create {
            path: "later.md".to_string(),
            bytes: b"later".to_vec(),
        };

        let result = Files::new(&root).apply(&[replace("note.md", "mine", None), later]);

        let kept = scratch_entries(&root);
        assert_eq!(kept.len(), 1, "{kept:?}");
        let write = FileStep::Write {
            path: "note.md".to_string(),
        };
        let Err(ApplyError::Partial {
            applied,
            failed,
            error: FileError::Io { cause, .. },
            not_attempted,
        }) = result.clone()
        else {
            panic!("a partial batch, not {result:?}");
        };
        assert_eq!(applied, vec![write.clone()]);
        assert_eq!(failed, write);
        assert_eq!(
            not_attempted,
            vec![FileStep::Write {
                path: "later.md".to_string()
            }]
        );
        assert!(cause.contains("is a directory"), "{cause}");
        assert!(cause.contains(&kept[0].display().to_string()), "{cause}");
        assert!(cause.contains("Inspect 'note.md'"), "{cause}");
        assert_eq!(fs::read_to_string(root.join("note.md")).unwrap(), "mine");
        assert_eq!(
            fs::read_to_string(kept[0].join("inside.md")).unwrap(),
            "kept"
        );
        assert!(!root.join("later.md").exists());
    }

    #[test]
    fn a_displaced_symbolic_link_is_kept_and_what_it_names_is_untouched() {
        let temp = TempDir::new("exchange-link");
        let root = temp.folder("link");
        let outside = temp.folder("outside").join("target.md");
        fs::write(&outside, "outside").unwrap();
        fs::write(root.join("note.md"), "read").unwrap();
        let named = outside.clone();
        let _around = Around::new(
            Some(Box::new(move |target: &Path| {
                fs::remove_file(target).unwrap();
                std::os::unix::fs::symlink(&named, target).unwrap();
            })),
            None,
        );

        let result = Files::new(&root).apply(&[replace("note.md", "mine", None)]);

        assert!(
            matches!(result, Err(ApplyError::Partial { .. })),
            "{result:?}"
        );
        let kept = scratch_entries(&root);
        assert_eq!(kept.len(), 1, "{kept:?}");
        assert!(fs::symlink_metadata(&kept[0])
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_link(&kept[0]).unwrap(), outside);
        assert_eq!(fs::read_to_string(&outside).unwrap(), "outside");
        assert_eq!(fs::read_to_string(root.join("note.md")).unwrap(), "mine");
    }

    #[test]
    fn a_third_writers_bytes_after_the_exchange_stay() {
        for displaced_directory in [true, false] {
            let temp = TempDir::new("exchange-third");
            let root = temp.folder("third");
            fs::write(root.join("note.md"), "read").unwrap();
            let before: Option<Hook> = if displaced_directory {
                Some(Box::new(directory_at))
            } else {
                None
            };
            let _around = Around::new(
                before,
                Some(Box::new(|target: &Path| fs::write(target, "C").unwrap())),
            );

            let result = Files::new(&root).apply(&[replace("note.md", "mine", None)]);

            assert_eq!(fs::read_to_string(root.join("note.md")).unwrap(), "C");
            if displaced_directory {
                assert!(
                    matches!(result, Err(ApplyError::Partial { .. })),
                    "{result:?}"
                );
                assert_eq!(scratch_entries(&root).len(), 1);
            } else {
                // A regular file was displaced and removed; the path was not touched.
                assert_eq!(result, Ok(()));
                assert_eq!(scratch_entries(&root), Vec::<PathBuf>::new());
            }
        }
    }

    #[test]
    fn a_displaced_regular_file_is_removed() {
        let temp = TempDir::new("exchange-displaced");
        let root = temp.folder("displaced");
        fs::write(root.join("note.md"), "read").unwrap();

        let result = Files::new(&root).apply(&[replace("note.md", "mine", Some(&sha256(b"read")))]);

        assert_eq!(result, Ok(()));
        assert_eq!(fs::read_to_string(root.join("note.md")).unwrap(), "mine");
        assert_eq!(scratch_entries(&root), Vec::<PathBuf>::new());
    }
}
