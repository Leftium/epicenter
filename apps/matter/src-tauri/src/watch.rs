//! Watch a vault folder: stream its markdown + model as self-contained deltas.
//!
//! One command owns the whole live-folder protocol. `watch_folder` arms a
//! `notify` watcher (non-recursive, top level only), THEN scans the folder and
//! pushes its current contents as the first delta batch, then streams a batch
//! per debounced change. Arming before the scan closes the read-then-watch gap.
//!
//! Each delta is self contained: a basename plus the file's observable state
//! (readable text / removed / unreadable), so the frontend never round-trips a
//! separate read. There is no fs-scope to configure: it touches only the
//! absolute path the dialog returned.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use notify_debouncer_full::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

type FolderWatcher = Debouncer<RecommendedWatcher, RecommendedCache>;

/// Active watchers keyed by id, kept alive until `unwatch_folder` drops them
/// (dropping the debouncer stops the OS watch).
#[derive(Default)]
pub struct WatcherStore {
    next: AtomicU32,
    watchers: Mutex<HashMap<u32, FolderWatcher>>,
}

/// One file's observable state. The file's basename (top level, non-recursive) is the
/// row identity the frontend keys on, sent as `fileName`. Serialized as a `{ kind, ... }` union.
///
/// This enum is the SINGLE SOURCE OF TRUTH for the IPC payload: `ts-rs` derives the
/// matching TS `FileDelta` into `src/lib/bindings/FileDelta.ts` (run `cargo test`
/// after changing the variants), so the frontend imports it instead of hand-mirroring
/// it. `notify_debouncer_full` and `Channel` carry it; `serde` and `ts-rs` read the
/// same `tag`/`rename_all`, so the wire shape and the generated type stay in lockstep
/// by construction.
#[derive(Clone, Serialize, ts_rs::TS)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub enum FileDelta {
    /// Read as UTF-8 text: the frontend parses it into a row (or its own
    /// "Can't read" bucket on bad YAML / conflict markers).
    Content { file_name: String, text: String },
    /// Gone from disk: the frontend drops it.
    Removed { file_name: String },
    /// Present but not UTF-8 text (binary, permission): the frontend routes it
    /// to "Can't read" rather than silently dropping it.
    Unreadable { file_name: String },
}

/// Only `.md` files and `matter.json` are part of the model; everything else in
/// the folder is ignored (mirrors the non-recursive, flat one-folder-is-a-table
/// shape). The frontend owns no path logic: this filter and the basename are Rust's.
fn is_relevant(name: &str) -> bool {
    name == "matter.json" || name.ends_with(".md")
}

/// Read one entry's current state. `path` is absolute; `file_name` is its basename.
/// A vanished file is `Removed`; a present-but-undecodable file is `Unreadable`,
/// never a hard failure of the surrounding scan.
fn delta_for(file_name: String, path: &Path) -> FileDelta {
    match std::fs::read_to_string(path) {
        Ok(text) => FileDelta::Content { file_name, text },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => FileDelta::Removed { file_name },
        Err(_) => FileDelta::Unreadable { file_name },
    }
}

/// Scan the folder's current relevant files (the seed batch). Errors only if the
/// directory itself can't be listed; an unreadable individual file becomes an
/// `Unreadable` delta, not a failure.
fn scan(dir: &Path) -> Result<Vec<FileDelta>, String> {
    let mut deltas = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if is_relevant(&name) {
            deltas.push(delta_for(name, &entry.path()));
        }
    }
    Ok(deltas)
}

#[tauri::command]
pub fn watch_folder(
    path: String,
    channel: Channel<Vec<FileDelta>>,
    store: State<WatcherStore>,
) -> Result<u32, String> {
    let dir = std::path::PathBuf::from(&path);
    let tx = channel.clone();
    // Coalesce an external write burst (agent / git / editor) into one batch. Writes
    // land atomically (entry.rs renames over the file), so no debounce value risks a
    // torn read; this is purely how fast EXTERNAL edits surface. The app's own edits do
    // not wait on this path (the write applies its own result), so 100ms favors latency
    // over deeper coalescing without the app ever feeling it.
    let mut debouncer = new_debouncer(
        Duration::from_millis(100),
        None,
        move |result: DebounceEventResult| {
            let Ok(events) = result else { return };
            // Dedup by basename within the tick; read each changed file once.
            let mut changed: HashMap<String, std::path::PathBuf> = HashMap::new();
            for event in events {
                for p in event.paths.iter() {
                    let Some(name) = p.file_name().map(|s| s.to_string_lossy().to_string()) else {
                        continue;
                    };
                    if is_relevant(&name) {
                        changed.insert(name, p.clone());
                    }
                }
            }
            if changed.is_empty() {
                return;
            }
            let deltas: Vec<FileDelta> = changed
                .into_iter()
                .map(|(name, p)| delta_for(name, &p))
                .collect();
            let _ = tx.send(deltas);
        },
    )
    .map_err(|e| e.to_string())?;

    // Arm the watcher BEFORE scanning so a change during the scan can't slip
    // through the read-then-watch gap; then push the current contents as the
    // first batch (the seed). Dropping the debouncer on any early return stops
    // the OS watch, so a failed scan never leaks a watcher.
    debouncer
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;
    let seed = scan(&dir)?;
    if !seed.is_empty() {
        let _ = channel.send(seed);
    }

    let id = store.next.fetch_add(1, Ordering::Relaxed);
    store.watchers.lock().unwrap().insert(id, debouncer);
    Ok(id)
}

#[tauri::command]
pub fn unwatch_folder(id: u32, store: State<WatcherStore>) {
    store.watchers.lock().unwrap().remove(&id);
}

/// A vault root's observable shape. `tables` are the immediate child directories, each one a
/// table. `root_has_table_files` is true when the root itself has files that belong inside a table
/// folder (`matter.json` or `.md`), so the UI can distinguish an empty vault from a table folder
/// opened at the wrong altitude.
#[derive(Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/bindings/")]
pub struct VaultMembership {
    tables: Vec<String>,
    root_has_table_files: bool,
}

/// The vault root's immediate child DIRECTORIES, each one a table, as absolute paths sorted for
/// a deterministic order. Loose files at the root (a stray `README.md`) are ignored for
/// membership, but relevant table files are reported so the frontend can explain the wrong-altitude
/// case. Errors only if the root itself cannot be listed; a child that races away mid-scan just
/// does not appear, surfacing on the next re-scan.
fn scan_vault(root: &Path) -> Result<VaultMembership, String> {
    let mut dirs = Vec::new();
    let mut root_has_table_files = false;
    for entry in std::fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if file_type.is_dir() {
            dirs.push(entry.path().to_string_lossy().to_string());
        } else if file_type.is_file() {
            let name = entry.file_name().to_string_lossy().to_string();
            if is_relevant(&name) {
                root_has_table_files = true;
            }
        }
    }
    dirs.sort();
    Ok(VaultMembership {
        tables: dirs,
        root_has_table_files,
    })
}

/// Watch a VAULT root: stream the set of table folders beneath it as a full, sorted membership
/// snapshot. This is the layer above `watch_folder`: where that watches ONE folder's files, this
/// watches the root NON-recursively for child folders appearing and disappearing, and the JS Vault
/// reacts by composing or disposing a per-folder `watch_folder`.
///
/// Each push is the WHOLE child-folder list, not a precise add/remove delta, and the JS reconciles
/// it against its current set (the same "a full rebuild is a pure function of truth" stance the
/// per-table SQLite mirror takes). A remove event cannot be stat-ed to tell folder from file, so
/// re-listing is both simpler and correct: any debounced change at the root re-scans the children.
/// A `matter.json` gained or lost INSIDE a child does not fire here (non-recursive); that child's
/// own `watch_folder` already carries it, so this layer only owns membership.
#[tauri::command]
pub fn watch_vault(
    path: String,
    channel: Channel<VaultMembership>,
    store: State<WatcherStore>,
) -> Result<u32, String> {
    let dir = std::path::PathBuf::from(&path);
    let root = dir.clone();
    let tx = channel.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(100),
        None,
        move |result: DebounceEventResult| {
            // The events are not parsed: a child folder added, removed, or renamed all reduce to
            // "the membership may have changed, re-scan." A failed scan (root vanished) sends
            // nothing and self-heals on the next event.
            let Ok(_events) = result else { return };
            if let Ok(membership) = scan_vault(&root) {
                let _ = tx.send(membership);
            }
        },
    )
    .map_err(|e| e.to_string())?;

    // Arm BEFORE the seed scan so a child appearing during the scan can't slip through the
    // list-then-watch gap; then send the current membership (always, even empty: an empty vault
    // is a valid state, not an error).
    debouncer
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;
    let seed = scan_vault(&dir)?;
    let _ = channel.send(seed);

    let id = store.next.fetch_add(1, Ordering::Relaxed);
    store.watchers.lock().unwrap().insert(id, debouncer);
    Ok(id)
}

/// Stop a vault root watch. Symmetric with `unwatch_folder`; both drop the debouncer the id keys,
/// which stops the OS watch. Named apart so each JS layer reads at its own altitude.
#[tauri::command]
pub fn unwatch_vault(id: u32, store: State<WatcherStore>) {
    store.watchers.lock().unwrap().remove(&id);
}
