//! The `read_folder` command: read a vault folder's markdown + model.
//!
//! Reads the absolute path the dialog returned (no `tauri-plugin-fs` scope to
//! configure). Top level only, non-recursive: `.md` files become `entries`, a
//! `matter.json` becomes `model_text`, everything else is ignored. Mirrors the
//! browser File System Access impl so both sides of `#platform/fs` agree.

use serde::Serialize;

#[derive(Serialize)]
pub struct MarkdownFile {
    pub name: String,
    pub content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderContents {
    pub name: String,
    pub entries: Vec<MarkdownFile>,
    pub model_text: Option<String>,
}

#[tauri::command]
pub fn read_folder(path: String) -> Result<FolderContents, String> {
    let dir = std::path::Path::new(&path);

    let mut entries = Vec::new();
    let mut model_text = None;

    let read_dir = std::fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in read_dir {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name == "matter.json" {
            model_text = Some(std::fs::read_to_string(entry.path()).map_err(|e| e.to_string())?);
        } else if name.ends_with(".md") {
            let content = std::fs::read_to_string(entry.path()).map_err(|e| e.to_string())?;
            entries.push(MarkdownFile { name, content });
        }
    }

    let name = dir
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());

    Ok(FolderContents {
        name,
        entries,
        model_text,
    })
}
