use rayon::prelude::*;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

// Types

#[derive(serde::Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DeleteFilesSelection {
    Filenames { filenames: Vec<String> },
}

// Helpers

/// Validates a filename is a single path component with no directory traversal.
/// Rejects empty strings, paths with separators (`foo/bar`), and parent refs (`..`).
pub(crate) fn validate_leaf_filename(filename: &str) -> Result<&str, String> {
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

fn delete_paths(paths: Vec<PathBuf>) -> u32 {
    let deleted = AtomicU32::new(0);

    paths.par_iter().for_each(|path| {
        if path.exists() && path.is_file() && fs::remove_file(path).is_ok() {
            deleted.fetch_add(1, Ordering::Relaxed);
        }
    });

    deleted.load(Ordering::Relaxed)
}

// Commands

/// Deletes files inside a directory by filename.
/// Validates filenames are single path components with no directory traversal.
/// Uses Rayon for parallel deletion. Silently skips missing files.
///
/// # Arguments
/// * `directory` - Absolute path to the directory containing the files
/// * `selection` - Named leaf filenames to delete
#[tauri::command]
#[specta::specta]
pub async fn delete_files_in_directory(
    directory: String,
    selection: DeleteFilesSelection,
) -> Result<u32, String> {
    tokio::task::spawn_blocking(move || {
        let dir_path = PathBuf::from(&directory);

        if !dir_path.is_absolute() {
            return Err(format!("Directory must be absolute: {}", directory));
        }

        match selection {
            DeleteFilesSelection::Filenames { filenames } => {
                let validated: Vec<&str> = filenames
                    .iter()
                    .map(|f| validate_leaf_filename(f))
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(delete_paths(
                    validated
                        .iter()
                        .map(|filename| dir_path.join(filename))
                        .collect(),
                ))
            }
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}
