//! Folder watching: stream debounced top-level change events to the frontend.
//!
//! A custom `notify` watcher (not `tauri-plugin-fs`'s) so there is no fs scope to
//! configure: it watches whatever absolute path the dialog returned, mirroring
//! `read_folder`. Non-recursive, matching the flat one-folder-is-a-table model.
//! Events are debounced (native OS events via `notify`) and pushed over a
//! `tauri::ipc::Channel`; the JS side re-reads each changed path with `read_file`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use notify_debouncer_full::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{
    new_debouncer, DebounceEventResult, Debouncer, RecommendedCache,
};
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

/// One debounced batch of changed absolute paths.
#[derive(Clone, Serialize)]
pub struct WatchPayload {
    pub paths: Vec<String>,
}

#[tauri::command]
pub fn watch_folder(
    path: String,
    channel: Channel<WatchPayload>,
    store: State<WatcherStore>,
) -> Result<u32, String> {
    let tx = channel.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(300),
        None,
        move |result: DebounceEventResult| {
            let Ok(events) = result else { return };
            let mut paths = Vec::new();
            for event in events {
                for p in event.paths.iter() {
                    paths.push(p.to_string_lossy().to_string());
                }
            }
            if !paths.is_empty() {
                let _ = tx.send(WatchPayload { paths });
            }
        },
    )
    .map_err(|e| e.to_string())?;

    debouncer
        .watch(std::path::Path::new(&path), RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    let id = store.next.fetch_add(1, Ordering::Relaxed);
    store.watchers.lock().unwrap().insert(id, debouncer);
    Ok(id)
}

#[tauri::command]
pub fn unwatch_folder(id: u32, store: State<WatcherStore>) {
    store.watchers.lock().unwrap().remove(&id);
}
