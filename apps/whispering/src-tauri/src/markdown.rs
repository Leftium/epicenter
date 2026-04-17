use rayon::prelude::*;
use std::collections::HashSet;
use std::ffi::OsStr;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use tempfile::NamedTempFile;

/// Counts markdown files in a directory without reading their contents.
/// This is extremely fast as it only checks file extensions without I/O.
///
/// Performance characteristics:
/// - No file I/O (only directory metadata)
/// - Single-threaded is sufficient (directory reading is fast)
/// - Returns immediately with just a count
///
/// # Arguments
/// * `directory_path` - Absolute path to the directory containing .md files
///
/// # Returns
/// * `Ok(usize)` - Number of .md files in the directory
/// * `Err(String)` - Error message if reading fails
#[tauri::command]
pub async fn count_markdown_files(directory_path: String) -> Result<usize, String> {
    tokio::task::spawn_blocking(move || {
        let dir_path = PathBuf::from(&directory_path);

        // Early returns for invalid paths
        if !dir_path.exists() {
            return Ok(0);
        }

        if !dir_path.is_dir() {
            return Err(format!("{} is not a directory", directory_path));
        }

        // Count .md files
        let count = fs::read_dir(&dir_path)
            .map_err(|e| format!("Failed to read directory {}: {}", directory_path, e))?
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                let path = entry.path();
                path.is_file() && path.extension().map_or(false, |ext| ext == "md")
            })
            .count();

        Ok::<usize, String>(count)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Reads all markdown files from a directory in parallel and returns their contents as strings.
/// This is optimized for bulk reading with parallel I/O using Rayon.
///
/// Performance characteristics:
/// - Uses Rayon for parallel file reading (utilizes all CPU cores)
/// - Wrapped in spawn_blocking for proper async handling
/// - ~3-4x faster than sequential reads for large directories
///
/// # Arguments
/// * `directory_path` - Absolute path to the directory containing .md files
///
/// # Returns
/// * `Ok(Vec<String>)` - Array of markdown file contents
/// * `Err(String)` - Error message if reading fails
#[tauri::command]
pub async fn read_markdown_files(directory_path: String) -> Result<Vec<String>, String> {
    // Wrap all blocking I/O in spawn_blocking to avoid blocking the Tokio runtime
    tokio::task::spawn_blocking(move || {
        let dir_path = PathBuf::from(&directory_path);

        // Early returns for invalid paths
        if !dir_path.exists() {
            return Ok(Vec::new());
        }

        if !dir_path.is_dir() {
            return Err(format!("{} is not a directory", directory_path));
        }

        // Step 1: Collect all .md file paths
        // This is fast and sequential is fine
        let paths: Vec<PathBuf> = fs::read_dir(&dir_path)
            .map_err(|e| format!("Failed to read directory {}: {}", directory_path, e))?
            .filter_map(|entry| {
                let entry = entry.ok()?;
                let path = entry.path();

                // Only include .md files
                if path.is_file() && path.extension()? == "md" {
                    Some(path)
                } else {
                    None
                }
            })
            .collect();

        // Step 2: Read all files in parallel using Rayon
        // par_iter() automatically distributes work across CPU cores
        let contents: Vec<String> = paths
            .par_iter()
            .filter_map(|path| fs::read_to_string(path).ok())
            .collect();

        Ok::<Vec<String>, String>(contents)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Deletes multiple files in parallel given their absolute paths.
/// This is a single FFI call that handles bulk deletion natively in Rust,
/// avoiding thousands of individual async calls for file removal.
///
/// Performance characteristics:
/// - Uses Rayon for parallel file deletion (utilizes all CPU cores)
/// - Wrapped in spawn_blocking for proper async handling
/// - Silently skips files that don't exist or can't be deleted
///
/// # Arguments
/// * `paths` - Array of absolute file paths to delete
///
/// # Returns
/// * `Ok(u32)` - Number of files successfully deleted
/// * `Err(String)` - Error message if the operation fails catastrophically
#[tauri::command]
pub async fn bulk_delete_files(paths: Vec<String>) -> Result<u32, String> {
    tokio::task::spawn_blocking(move || {
        let deleted = AtomicU32::new(0);

        // Delete all files in parallel using Rayon
        paths.par_iter().for_each(|path| {
            let path = PathBuf::from(path);
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

#[derive(serde::Deserialize)]
pub struct MarkdownFile {
    filename: String,
    content: String,
}

fn validate_markdown_filename(filename: &str) -> Result<&str, String> {
    if filename.is_empty() {
        return Err("Filename cannot be empty".to_string());
    }

    let path = Path::new(filename);
    let mut components = path.components();

    match (components.next(), components.next()) {
        (Some(Component::Normal(_)), None) => {}
        _ => return Err(format!("Invalid filename: {}", filename)),
    }

    if path.extension() != Some(OsStr::new("md")) {
        return Err(format!("Filename must end with .md: {}", filename));
    }

    Ok(filename)
}

/// Writes markdown files to disk atomically using a temporary file plus persist.
/// Ensures the target directory exists before writing.
///
/// Each file is written to a temporary file in the target directory, then
/// persisted to `{directory}/{filename}`. This prevents partial reads from
/// observers or external tools watching the directory.
///
/// # Arguments
/// * `directory` - Absolute path to the output directory
/// * `files` - Array of `{ filename, content }` pairs to write
///
/// # Returns
/// * `Ok(u32)` - Number of files successfully written
/// * `Err(String)` - Error message if any write fails
#[tauri::command]
pub async fn write_markdown_files(
    directory: String,
    files: Vec<MarkdownFile>,
) -> Result<u32, String> {
    tokio::task::spawn_blocking(move || {
        let dir_path = PathBuf::from(&directory);

        if !dir_path.is_absolute() {
            return Err(format!("Directory must be absolute: {}", directory));
        }

        let mut seen = HashSet::with_capacity(files.len());
        for file in &files {
            let filename = validate_markdown_filename(&file.filename)?;

            if !seen.insert(filename.to_owned()) {
                return Err(format!("Duplicate filename in request: {}", filename));
            }
        }

        fs::create_dir_all(&dir_path)
            .map_err(|e| format!("Failed to create directory {}: {}", directory, e))?;

        let mut written = 0u32;
        for file in &files {
            let filename = validate_markdown_filename(&file.filename)?;
            let path = dir_path.join(filename);
            let mut temp = NamedTempFile::new_in(&dir_path)
                .map_err(|e| format!("Failed to create temp file for {}: {}", filename, e))?;

            temp.write_all(file.content.as_bytes())
                .map_err(|e| format!("Failed to write {}: {}", filename, e))?;
            temp.persist(&path)
                .map_err(|e| format!("Failed to persist {}: {}", filename, e.error))?;

            written += 1;
        }

        Ok::<u32, String>(written)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}
