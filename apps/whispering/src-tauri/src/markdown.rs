use rayon::prelude::*;
use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use tempfile::NamedTempFile;

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(serde::Deserialize, specta::Type)]
pub struct MarkdownFile {
    filename: String,
    content: String,
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/// Validates a filename is a single path component (no directory traversal).
/// Rejects empty strings, paths with separators (`foo/bar`), and parent refs (`..`).
fn validate_leaf_filename(filename: &str) -> Result<&str, String> {
    if filename.is_empty() {
        return Err("Filename cannot be empty".to_string());
    }
    let path = Path::new(filename);
    let mut components = path.components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(_)), None) => {}
        _ => return Err(format!("Invalid filename: {}", filename)),
    }
    Ok(filename)
}

// ── Commands ────────────────────────────────────────────────────────────────


/// Writes markdown files to disk atomically using a temporary file plus persist.
/// Validates all filenames upfront\u2014no files are written if any name is invalid.
///
/// # Arguments
/// * `directory` - Absolute path to the output directory
/// * `files` - Array of `{ filename, content }` pairs to write
///
/// # Returns
/// * `Ok(())` - All files written successfully
/// * `Err(String)` - Error if any write fails (earlier files may already be on disk)
#[tauri::command]
#[specta::specta]
pub async fn write_markdown_files(
    directory: String,
    files: Vec<MarkdownFile>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let dir_path = PathBuf::from(&directory);

        if !dir_path.is_absolute() {
            return Err(format!("Directory must be absolute: {}", directory));
        }

        // Two-pass approach: validate all filenames first, then write.
        // If any filename is invalid or duplicated, no files touch disk.
        let validated: Vec<&str> = {
            let mut seen = HashSet::with_capacity(files.len());
            let mut names = Vec::with_capacity(files.len());
            for file in &files {
                let name = validate_leaf_filename(&file.filename)?;
                if !seen.insert(name) {
                    return Err(format!("Duplicate filename in request: {}", name));
                }
                names.push(name);
            }
            names
        };

        fs::create_dir_all(&dir_path)
            .map_err(|e| format!("Failed to create directory {}: {}", directory, e))?;

        for (file, filename) in files.iter().zip(validated.iter()) {
            let path = dir_path.join(filename);
            let mut temp = NamedTempFile::new_in(&dir_path)
                .map_err(|e| format!("Failed to create temp file for {}: {}", filename, e))?;

            temp.write_all(file.content.as_bytes())
                .map_err(|e| format!("Failed to write {}: {}", filename, e))?;
            temp.persist(&path)
                .map_err(|e| format!("Failed to persist {}: {}", filename, e.error))?;
        }

        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Deletes files inside a directory by filename.
/// Validates filenames are single path components (no traversal).
/// Uses Rayon for parallel deletion. Silently skips missing files.
///
/// # Arguments
/// * `directory` - Absolute path to the directory containing the files
/// * `filenames` - Array of leaf filenames to delete
#[tauri::command]
#[specta::specta]
pub async fn delete_files_in_directory(
    directory: String,
    filenames: Vec<String>,
) -> Result<u32, String> {
    tokio::task::spawn_blocking(move || {
        let dir_path = PathBuf::from(&directory);

        if !dir_path.is_absolute() {
            return Err(format!("Directory must be absolute: {}", directory));
        }

        let validated: Vec<&str> = filenames
            .iter()
            .map(|f| validate_leaf_filename(f))
            .collect::<Result<Vec<_>, _>>()?;

        let deleted = AtomicU32::new(0);

        validated.par_iter().for_each(|filename| {
            let path = dir_path.join(filename);
            if path.exists() && path.is_file() {
                if fs::remove_file(&path).is_ok() {
                    deleted.fetch_add(1, Ordering::Relaxed);
                }
            }
        });

        Ok::<u32, String>(deleted.load(Ordering::Relaxed))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}
