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

/// Deletes files inside a directory by filename.
/// Validates that filenames are single path components (no traversal).
///
/// Uses Rayon for parallel deletion. Silently skips files that don't exist.
///
/// # Arguments
/// * `directory` - Absolute path to the directory containing the files
/// * `filenames` - Array of leaf filenames to delete (e.g. `["abc.md", "abc.webm"]`)
///
/// # Returns
/// * `Ok(u32)` - Number of files successfully deleted
/// * `Err(String)` - If directory is not absolute or a filename is invalid
#[tauri::command]
pub async fn delete_files_in_directory(
    directory: String,
    filenames: Vec<String>,
) -> Result<u32, String> {
    tokio::task::spawn_blocking(move || {
        let dir_path = PathBuf::from(&directory);

        if !dir_path.is_absolute() {
            return Err(format!("Directory must be absolute: {}", directory));
        }

        // Validate all filenames before deleting any
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

#[derive(serde::Deserialize)]
pub struct MarkdownFile {
    filename: String,
    content: String,
}

/// Validates a filename is a single path component (no directory traversal).
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

/// Validates a filename is a single `.md` path component.
fn validate_markdown_filename(filename: &str) -> Result<&str, String> {
    let name = validate_leaf_filename(filename)?;
    if Path::new(name).extension() != Some(OsStr::new("md")) {
        return Err(format!("Filename must end with .md: {}", name));
    }
    Ok(name)
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
/// * `Ok(())` - All files written successfully
/// * `Err(String)` - Error message if any write fails (earlier files may already be on disk)
#[tauri::command]
pub async fn write_markdown_files(
    directory: String,
    files: Vec<MarkdownFile>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let dir_path = PathBuf::from(&directory);

        if !dir_path.is_absolute() {
            return Err(format!("Directory must be absolute: {}", directory));
        }

        // Validate all filenames upfront so no files are written if any name is invalid
        let validated: Vec<&str> = {
            let mut seen = HashSet::with_capacity(files.len());
            let mut names = Vec::with_capacity(files.len());
            for file in &files {
                let name = validate_markdown_filename(&file.filename)?;
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
