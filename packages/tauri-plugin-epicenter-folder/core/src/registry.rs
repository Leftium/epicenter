//! Which window may use which folder.
//!
//! The shell registers scopes: a scope ID, the folder's root and history
//! policy, and the window labels allowed to use it. A page names only the
//! scope ID. It never supplies a root, an author, a remote, or a policy, so a
//! compromised page cannot point the owner somewhere else.
//!
//! The registry opens a scope's owner on first attach, after taking the
//! cross-process lock for the canonical root, and keeps it until `shutdown`.
//! Detaching a window drops that window's session and nothing else: the owner,
//! its queued commits, and every other window's session carry on.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use specta::Type;

use crate::files::resolve_root;
use crate::lock::{LockError, RootLock};
use crate::owner::{FolderConfig, FolderOwner};

#[derive(Debug, Clone)]
pub struct ScopeConfig {
    /// The only thing a page names.
    pub scope: String,
    pub folder: FolderConfig,
    /// Labels of the windows that may attach to this scope.
    pub windows: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "name")]
pub enum AttachError {
    /// The shell registered no folder under this scope.
    UnknownScope { scope: String },
    /// The scope exists, but this window is not one of its windows.
    WindowNotPermitted { scope: String, window: String },
    /// Another process holds the folder.
    Busy { root: String },
    /// The folder could not be locked or opened.
    Unavailable { message: String },
    /// The shell is shutting its folders down.
    ShuttingDown,
    /// The page was built against another version of the command contract.
    Incompatible { host: u32, page: u32 },
}

struct Opened {
    owner: FolderOwner,
    /// Held for as long as the owner exists; dropped after it has drained.
    lock: RootLock,
}

struct Scope {
    config: ScopeConfig,
    opened: Option<Opened>,
}

/// One window's use of one scope.
pub struct Session {
    scope: String,
    window: String,
    owner: FolderOwner,
}

impl Session {
    pub fn scope(&self) -> &str {
        &self.scope
    }

    pub fn window(&self) -> &str {
        &self.window
    }

    /// The owner, for the window this session was attached from and no other.
    pub fn authorize(&self, window: &str) -> Result<&FolderOwner, String> {
        if window == self.window {
            Ok(&self.owner)
        } else {
            Err(format!(
                "this folder session belongs to the window '{}', not '{window}'",
                self.window
            ))
        }
    }
}

#[derive(Default)]
pub struct Registry {
    scopes: Mutex<BTreeMap<String, Scope>>,
    fenced: AtomicBool,
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    fn scopes(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, Scope>> {
        self.scopes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Register a scope. Trusted shell code calls this once it has resolved
    /// its paths; a scope's configuration never changes afterward.
    pub fn register(&self, config: ScopeConfig) -> Result<(), String> {
        if self.fenced.load(Ordering::SeqCst) {
            return Err("the folder registry is shutting down".to_string());
        }
        if config.scope.trim().is_empty() {
            return Err("a folder scope needs a nonempty ID".to_string());
        }
        let mut scopes = self.scopes();
        if scopes.contains_key(&config.scope) {
            return Err(format!(
                "the folder scope '{}' is already registered",
                config.scope
            ));
        }
        scopes.insert(
            config.scope.clone(),
            Scope {
                config,
                opened: None,
            },
        );
        Ok(())
    }

    /// Attach `window` to `scope`, opening the folder if this is its first use.
    pub fn attach(&self, scope: &str, window: &str) -> Result<Session, AttachError> {
        let mut scopes = self.scopes();
        if self.fenced.load(Ordering::SeqCst) {
            return Err(AttachError::ShuttingDown);
        }
        let Some(entry) = scopes.get_mut(scope) else {
            return Err(AttachError::UnknownScope {
                scope: scope.to_string(),
            });
        };
        if !entry
            .config
            .windows
            .iter()
            .any(|permitted| permitted == window)
        {
            return Err(AttachError::WindowNotPermitted {
                scope: scope.to_string(),
                window: window.to_string(),
            });
        }
        if entry.opened.is_none() {
            let unavailable = |message: String| AttachError::Unavailable { message };
            // Lock the canonical directory before Git is initialized there.
            let root = resolve_root(&entry.config.folder.root).map_err(unavailable)?;
            let lock = RootLock::acquire(&root).map_err(|error| match error {
                LockError::Busy { root } => AttachError::Busy {
                    root: root.display().to_string(),
                },
                LockError::Failed { message } => unavailable(message),
            })?;
            let owner = FolderOwner::open(FolderConfig {
                root,
                ..entry.config.folder.clone()
            })
            .map_err(unavailable)?;
            entry.opened = Some(Opened { owner, lock });
        }
        let opened = entry.opened.as_ref().expect("the scope was just opened");
        Ok(Session {
            scope: scope.to_string(),
            window: window.to_string(),
            owner: opened.owner.clone(),
        })
    }

    /// Fence new attaches, drain every owner, then release every folder's
    /// cross-process lock. Returns once all of that has happened.
    pub fn shutdown(&self) {
        let opened: Vec<Opened> = {
            let mut scopes = self.scopes();
            self.fenced.store(true, Ordering::SeqCst);
            scopes
                .values_mut()
                .filter_map(|scope| scope.opened.take())
                .collect()
        };
        for Opened { owner, lock } in opened {
            owner.shutdown();
            drop(lock);
        }
    }
}
