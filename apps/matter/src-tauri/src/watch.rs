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

/// Whether a folder is a table: it contains a `matter.json` (ADR-0029). One metadata check,
/// mirroring `isMarked` in the CLI loader (`src/lib/load/fs.ts`). A marker that is absent (or
/// somehow not a regular file) means "not a table."
fn is_marked(dir: &Path) -> bool {
    dir.join("matter.json").is_file()
}

/// The vault's tables as absolute paths, applying the SAME marker rule the CLI loader uses
/// (`src/lib/load/fs.ts` `loadPath`, ADR-0029/0030), so the GUI and the CLI agree on what a path
/// is. A `matter.json` MARKS a table: a folder is a table if and only if it contains one. The
/// scope of a root is:
///
///   - the root itself, when it is marked (its `.md` files are rows); PLUS
///   - its immediate child directories that are themselves marked, sorted, as subtables.
///
/// No recursion: depth is reached by opening a subtable. An unmarked folder is not data (an
/// attachment bundle, junk, or an organizational dir) and is skipped, so a marked folder's child
/// folders that lack a marker never appear. Hidden directories (`.git`, `.obsidian`) are skipped
/// before the marker is even checked. An unmarked root with no marked children lists NOTHING ("no
/// tables here"), the honest answer in the declared-store model, where the old shape rule would
/// have called the same folder one table.
///
/// Errors only if the root itself cannot be listed; a child that races away mid-scan just does not
/// appear, surfacing on the next re-scan.
fn scan_vault(root: &Path) -> Result<Vec<String>, String> {
    // Self first (when marked), then the marked children sorted: matches `loadPath`'s
    // `[...selfTables, ...childTables]` order.
    let mut tables = Vec::new();
    if is_marked(root) {
        tables.push(root.to_string_lossy().to_string());
    }
    let mut children = Vec::new();
    for entry in std::fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            continue;
        }
        let path = entry.path();
        if is_marked(&path) {
            children.push(path.to_string_lossy().to_string());
        }
    }
    children.sort();
    tables.extend(children);
    Ok(tables)
}

/// Watch a VAULT root: stream its table list as a full, sorted snapshot. This is the layer above
/// `watch_folder`: where that watches ONE folder's files, this watches the root NON-recursively for
/// the table set changing, and the JS Vault reacts by composing or disposing a per-folder
/// `watch_folder`. Under the marker rule (ADR-0029) the set changes when a top-level entry appears
/// or disappears: a child directory (a potential subtable) OR the root's own `matter.json` (which
/// flips the root itself between a table and not-a-table). The root's `matter.json` is no longer an
/// inert loose file; re-scanning on any root event already accounts for it.
///
/// Each push is the WHOLE table list, not a precise add/remove delta, and the JS reconciles it
/// against its current set (the same "a full rebuild is a pure function of truth" stance the
/// per-table SQLite mirror takes). A remove event cannot be stat-ed to tell folder from file, so
/// re-listing is both simpler and correct: any debounced change at the root re-scans.
///
/// Live-detection depth (the spec's open question): the watch is non-recursive, so a `matter.json`
/// gained or lost INSIDE an existing child folder does NOT fire here, and a child that is not yet a
/// table has no `watch_folder` of its own to carry it. V1 surfaces such a flip on the next reopen
/// (or an app-initiated refresh, e.g. the "adopt folder" action, which knows it just wrote a
/// marker). Watching one level deeper for `matter.json` only is the future refinement.
#[tauri::command]
pub fn watch_vault(
    path: String,
    channel: Channel<Vec<String>>,
    store: State<WatcherStore>,
) -> Result<u32, String> {
    let dir = std::path::PathBuf::from(&path);
    let root = dir.clone();
    let tx = channel.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(100),
        None,
        move |result: DebounceEventResult| {
            // The events are not parsed: any change at the root reduces to "the table list may have
            // changed, re-scan." A failed scan (root vanished) sends nothing and self-heals on the
            // next event.
            let Ok(_events) = result else { return };
            if let Ok(tables) = scan_vault(&root) {
                let _ = tx.send(tables);
            }
        },
    )
    .map_err(|e| e.to_string())?;

    // Arm BEFORE the seed scan so a change during the scan can't slip through the list-then-watch
    // gap; then send the current table list (always, even a one-table or empty root: both are valid
    // states, not errors).
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh scratch dir for one case (mirrors `mirror.rs`), wiped first so a re-run starts clean.
    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "matter-watch-test-{}-{}-{:?}",
            std::process::id(),
            name,
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn s(path: &Path) -> String {
        path.to_string_lossy().to_string()
    }

    /// Mark a folder as a table by writing a `matter.json` into it (the `{}` untyped marker).
    fn mark(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("matter.json"), "{}").unwrap();
    }

    // These mirror `fs.test.ts` ("loadPath: scope = marked self + marked children") so the GUI
    // watcher and the CLI loader are pinned to the same marker rule (ADR-0029) in both languages.

    #[test]
    fn a_marked_folder_with_no_marked_children_is_a_lone_table() {
        let dir = scratch("lone");
        mark(&dir);
        std::fs::write(dir.join("note.md"), "# hi").unwrap();
        assert_eq!(scan_vault(&dir).unwrap(), vec![s(&dir)]);
    }

    #[test]
    fn an_unmarked_folder_yields_its_marked_children_sorted() {
        let dir = scratch("vault");
        mark(&dir.join("pages"));
        mark(&dir.join("adaptations"));
        // The root itself is not marked: it is just a container of tables, not a table.
        assert_eq!(
            scan_vault(&dir).unwrap(),
            vec![s(&dir.join("adaptations")), s(&dir.join("pages"))]
        );
    }

    #[test]
    fn a_marked_folder_nesting_marked_children_is_itself_plus_subtables() {
        // First-class nesting: the parent has its own rows AND child tables. Self first, then the
        // marked children sorted; no recursion past one level.
        let dir = scratch("nest");
        mark(&dir);
        mark(&dir.join("drafts"));
        mark(&dir.join("archive"));
        assert_eq!(
            scan_vault(&dir).unwrap(),
            vec![s(&dir), s(&dir.join("archive")), s(&dir.join("drafts"))]
        );
    }

    #[test]
    fn an_unmarked_subfolder_is_not_a_subtable() {
        // An attachment bundle: a subfolder with no matter.json is ignored, never a subtable.
        let dir = scratch("attachments");
        mark(&dir);
        std::fs::create_dir_all(dir.join("images")).unwrap();
        std::fs::write(dir.join("images").join("cover.md"), "# img").unwrap();
        assert_eq!(scan_vault(&dir).unwrap(), vec![s(&dir)]);
    }

    #[test]
    fn an_unmarked_folder_with_no_marked_children_lists_nothing() {
        // Not a table, and no marked children: "no tables here," not a single table.
        let dir = scratch("nothing");
        std::fs::write(dir.join("note.md"), "# hi").unwrap();
        std::fs::create_dir_all(dir.join("images")).unwrap();
        assert_eq!(scan_vault(&dir).unwrap(), Vec::<String>::new());
    }

    #[test]
    fn hidden_directories_are_never_tables() {
        // A hidden dir is skipped before the marker is even checked, even if it carries one.
        let dir = scratch("hidden");
        mark(&dir);
        mark(&dir.join(".git"));
        assert_eq!(scan_vault(&dir).unwrap(), vec![s(&dir)]);
    }
}
