//! Literal folder-relative paths.
//!
//! This is the Rust owner of the rules in `packages/app/src/files/paths.ts`.
//! Paths are never normalized, case folded, or aliased: a path that would need
//! rewriting to be usable is refused.

/// The root generated query index; derived data, never history source.
pub const GENERATED_INDEX: &str = "index.sqlite3";
/// Operating-system scratch files that commits and status never include.
const SCRATCH_NAMES: [&str; 1] = [".DS_Store"];

/// Why a literal path is unusable, or `None` when it is a valid
/// folder-relative path.
pub fn path_problem(path: &str) -> Option<&'static str> {
    if path.is_empty() {
        return Some("the path is empty");
    }
    if path.starts_with('/') {
        return Some("the path must be folder-relative");
    }
    if path.contains('\\') {
        return Some("the path contains a backslash");
    }
    if path.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7f) {
        return Some("the path contains a control character");
    }
    for segment in path.split('/') {
        if segment.is_empty() {
            return Some("the path contains an empty segment");
        }
        if segment == "." || segment == ".." {
            return Some("the path contains a relative segment");
        }
        // Git refuses `.git` at any depth, in any case, as a tracked path.
        if segment.to_lowercase() == ".git" {
            return Some("the path is inside private Git state");
        }
    }
    None
}

/// Candidate history source: every valid path except operating-system scratch
/// files and the root generated index. Ignore rules narrow it further.
pub fn is_portable_path(path: &str) -> bool {
    if path_problem(path).is_some() || path == GENERATED_INDEX {
        return false;
    }
    !SCRATCH_NAMES.contains(&basename(path))
}

pub fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// Every proper ancestor directory of a path, nearest last.
pub fn ancestors(path: &str) -> Vec<&str> {
    path.match_indices('/')
        .map(|(index, _)| &path[..index])
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_problem_refuses_what_paths_ts_refuses() {
        for (path, problem) in [
            ("", "the path is empty"),
            ("/a", "the path must be folder-relative"),
            ("a\\b", "the path contains a backslash"),
            ("a\nb", "the path contains a control character"),
            ("a\u{7f}", "the path contains a control character"),
            ("a//b", "the path contains an empty segment"),
            ("a/", "the path contains an empty segment"),
            ("a/../b", "the path contains a relative segment"),
            ("./a", "the path contains a relative segment"),
            (".git/config", "the path is inside private Git state"),
            ("sub/.GIT/x", "the path is inside private Git state"),
        ] {
            assert_eq!(path_problem(path), Some(problem), "{path:?}");
        }
        for path in [
            "a",
            "a/b.md",
            ".gitignore",
            "a/.gitkeep",
            "naïve/日本.md",
            "a b",
        ] {
            assert_eq!(path_problem(path), None, "{path:?}");
        }
    }

    #[test]
    fn portable_excludes_scratch_and_only_the_root_index() {
        assert!(!is_portable_path("index.sqlite3"));
        assert!(is_portable_path("sub/index.sqlite3"));
        assert!(!is_portable_path(".DS_Store"));
        assert!(!is_portable_path("notes/.DS_Store"));
        assert!(is_portable_path("notes/a.md"));
        assert!(!is_portable_path(".git/HEAD"));
    }

    #[test]
    fn ancestors_lists_nearest_last() {
        assert_eq!(ancestors("a/b/c.md"), vec!["a", "a/b"]);
        assert!(ancestors("a.md").is_empty());
    }
}
