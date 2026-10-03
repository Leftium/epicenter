//! Which page of which webview a session belongs to, kept by the plugin.
//!
//! A session must end with the page that attached it: when the page reloads,
//! and when its window is destroyed. Two facts about Tauri shape how:
//!
//! - By the time a plugin hears `Destroyed`, the manager has already forgotten
//!   the window and its webviews (`on_event_loop_event` calls
//!   `manager.on_window_close` first). The webview, and the resource table
//!   that holds its sessions, can no longer be reached by label.
//! - A label is not an identity. A window can be destroyed and another
//!   created under the same label while an old `Webview` handle is still
//!   held: by an `attach` in flight, or by a request the old page sent that
//!   is only now delivered. Asking "what is the lifecycle for this label"
//!   would hand that old handle the new window's lifecycle.
//!
//! So each actual webview gets its own `Instance`, made when Tauri announces
//! the webview and kept in that webview's own resource table. A handle's
//! clones share its table; a new webview under the same label has a new
//! table and a new instance. Commands and the page-load hook read the
//! instance of the webview they were given, never anything looked up by
//! label.
//!
//! - A page is one document in that webview. A reload starts the next page
//!   of that instance and no other.
//! - A session registers only with the instance and page that began
//!   attaching it, inside the instance's own lock, which is the lock that
//!   ending the instance and starting a page take. An attach that finishes
//!   late is refused.
//! - Destruction arrives as a window label, after the manager's entry is
//!   gone, so the plugin indexes instances weakly by owning window and ends
//!   every instance recorded for that window. An ended instance never
//!   accepts a session again.
//! - A page numbers its saves once, across every handle and root it opens.
//!   The instance keeps that page's writer for each canonical root, and
//!   every session the page attaches to the root shares it, so a save sent
//!   through one handle is ordered against a later save sent through
//!   another, or through a session attached after detaching. A new page
//!   starts with no writers; pages and windows are not ordered against each
//!   other.
//! - Ending a page or an instance drops its sessions' subscriptions and
//!   withdraws their unstarted pushes and fetches. It never touches the
//!   folder owner: saves the owner admitted still land, and every other
//!   window's sessions carry on.
//!
//! No webview or window handle is stored here. The index holds labels and
//! weak references; an instance is owned by its webview's resource table and
//! by the sessions registered with it.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};

use epicenter_folder_core::owner::{
    Caller, FolderOwner, Request, Submission, Subscription, Writer,
};
use epicenter_folder_core::registry::Session;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// What a live session holds. Dropping it stops the session's events and
/// withdraws its pushes and fetches that the owner has not started.
pub(crate) struct Live {
    pub session: Session,
    /// Orders this session's saves by the numbers the page gave them. It is
    /// the page's writer for the session's root, shared with every other
    /// session the page attached there, and it remembers, per path, the
    /// highest number that landed for as long as the page lasts. See
    /// `Instance::writer` and `SessionState::submit`.
    pub writer: Writer,
    /// The pushes and fetches this session opened and has not finished or
    /// withdrawn. This map is the only record of them: removing an entry
    /// drops its `Request`, which is what withdraws it.
    pub requests: BTreeMap<u64, OpenRequest>,
    pub _subscription: Subscription,
}

/// One push or fetch a page announced, and whether a command has taken it.
pub(crate) struct OpenRequest {
    request: Request,
    used: bool,
}

/// Request numbers are never reused, so a late withdrawal cannot name a newer
/// request. A number means nothing outside the session that opened it.
static NEXT_REQUEST: AtomicU64 = AtomicU64::new(1);

/// One window's session. The webview's resource table holds it strongly, for
/// lookup by resource ID; its instance holds it weakly, to end it.
pub(crate) struct SessionState {
    live: Mutex<Option<Live>>,
    /// The webview instance this session belongs to. Held so the instance,
    /// and with it the way to end this session when the window is destroyed,
    /// lasts as long as the session does.
    _instance: Arc<Instance>,
}

impl SessionState {
    pub fn new(instance: &Arc<Instance>, live: Live) -> Arc<Self> {
        Arc::new(Self {
            live: Mutex::new(Some(live)),
            _instance: Arc::clone(instance),
        })
    }

    /// End the session. Safe to call more than once.
    pub fn end(&self) {
        // Taken out under the lock, dropped outside it: dropping withdraws
        // requests and ends a subscription, which take the owner's own locks.
        let live = lock(&self.live).take();
        drop(live);
    }

    /// Whether the session has ended. Once true it stays true.
    pub fn ended(&self) -> bool {
        lock(&self.live).is_none()
    }

    /// The owner, for `window`, while the session is live.
    pub fn owner(&self, window: &str) -> Result<FolderOwner, String> {
        match &*lock(&self.live) {
            Some(live) => live.session.authorize(window).cloned(),
            None => Err(ENDED.to_string()),
        }
    }

    /// The owner, for `window`, and the save the page numbered `sequence`,
    /// taken together while the session is live. The page's saves to this
    /// root are ordered by the page's numbers, through whichever of its
    /// sessions they arrive, not by when they arrive here. A save that
    /// arrives after the session ended is refused here and writes nothing;
    /// one taken before keeps the page's record and still lands, unless a
    /// later save of the page, or this save itself, already landed on one of
    /// its paths.
    pub fn submit(&self, window: &str, sequence: u64) -> Result<(FolderOwner, Submission), String> {
        match &*lock(&self.live) {
            Some(live) => Ok((
                live.session.authorize(window)?.clone(),
                live.writer.submission(sequence),
            )),
            None => Err(ENDED.to_string()),
        }
    }

    /// Keep a request for as long as the session lives, under a new number. A
    /// session that ended meanwhile drops it.
    pub fn open_request(&self, request: Request) -> Result<u64, String> {
        match &mut *lock(&self.live) {
            Some(live) => {
                let id = NEXT_REQUEST.fetch_add(1, Ordering::SeqCst);
                live.requests.insert(
                    id,
                    OpenRequest {
                        request,
                        used: false,
                    },
                );
                Ok(id)
            }
            None => Err(ENDED.to_string()),
        }
    }

    /// Take a request for the one push or fetch it was opened for. A request
    /// that was withdrawn, finished, or never opened by this session is
    /// unknown here, and one already taken cannot be taken again.
    pub fn use_request(&self, id: u64) -> Result<Caller, String> {
        match lock(&self.live)
            .as_mut()
            .and_then(|live| live.requests.get_mut(&id))
        {
            Some(open) if !open.used => {
                open.used = true;
                Ok(open.request.caller())
            }
            Some(_) => Err("this request is already in use by another command".to_string()),
            None => Err(
                "this session has no such request: it was withdrawn, has finished, or was never opened; nothing was started for it"
                    .to_string(),
            ),
        }
    }

    /// Forget a request: its command finished, or its caller withdrew. Safe
    /// to call for a request that is already gone.
    pub fn close_request(&self, id: u64) {
        // Taken out under the lock, dropped outside it: dropping withdraws,
        // which takes the owner's own locks.
        let closed = lock(&self.live)
            .as_mut()
            .and_then(|live| live.requests.remove(&id));
        drop(closed);
    }
}

const ENDED: &str = "this folder session ended with the page that attached it; attach again";

fn end_all(sessions: Vec<Weak<SessionState>>) {
    for session in sessions.iter().filter_map(Weak::upgrade) {
        session.end();
    }
}

struct InstanceState {
    /// The instance's window was destroyed. Nothing registers after this.
    ended: bool,
    page: u64,
    sessions: Vec<Weak<SessionState>>,
    /// The current page's order of saves, one per canonical folder root.
    /// The page numbers its saves once for all its handles, so every session
    /// it attaches to a root, at once or after detaching, shares that root's
    /// writer. The next page starts with none: its numbers start again.
    writers: BTreeMap<PathBuf, Writer>,
}

/// One actual webview, from its creation to its window's destruction.
pub(crate) struct Instance {
    state: Mutex<InstanceState>,
}

/// The page of one instance an `attach` began in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Page(u64);

impl Instance {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(InstanceState {
                ended: false,
                page: 0,
                sessions: Vec::new(),
                writers: BTreeMap::new(),
            }),
        })
    }

    /// The page this webview is on now, unless its window is gone.
    pub fn page(&self) -> Option<Page> {
        let state = lock(&self.state);
        (!state.ended).then_some(Page(state.page))
    }

    /// The writer `page` orders its saves to `root` with, while this webview
    /// is alive and still on that page.
    pub fn writer(&self, page: Page, root: &Path) -> Option<Writer> {
        let mut state = lock(&self.state);
        if state.ended || state.page != page.0 {
            return None;
        }
        Some(state.writers.entry(root.to_path_buf()).or_default().clone())
    }

    /// A page started loading in this webview: the page before it is over.
    /// Its writers go with it; a save of it the owner already took keeps the
    /// record it was ordered by.
    pub fn page_started(&self) {
        let (ended, writers) = {
            let mut state = lock(&self.state);
            state.page += 1;
            (
                std::mem::take(&mut state.sessions),
                std::mem::take(&mut state.writers),
            )
        };
        drop(writers);
        end_all(ended);
    }

    /// This webview's window was destroyed.
    fn end(&self) {
        let (ended, writers) = {
            let mut state = lock(&self.state);
            state.ended = true;
            (
                std::mem::take(&mut state.sessions),
                std::mem::take(&mut state.writers),
            )
        };
        drop(writers);
        end_all(ended);
    }

    /// Register a session for the page that began attaching it. `add` puts
    /// the session where commands find it; it runs only if this webview is
    /// alive and still on that page, inside the same critical section as the
    /// check, so no destruction or reload can fall between them.
    pub fn register<T>(
        &self,
        page: Page,
        session: &Arc<SessionState>,
        add: impl FnOnce() -> T,
    ) -> Option<T> {
        let mut state = lock(&self.state);
        if state.ended || state.page != page.0 {
            return None;
        }
        state.sessions.retain(|known| known.strong_count() > 0);
        state.sessions.push(Arc::downgrade(session));
        Some(add())
    }
}

/// The plugin's index of instances by the window that owns them, for the one
/// event that names a window and nothing else.
#[derive(Default)]
pub(crate) struct Lifecycles {
    by_window: Mutex<Vec<(String, Weak<Instance>)>>,
}

impl Lifecycles {
    /// A new instance for a webview Tauri just announced, owned by `window`.
    /// The caller stores it in that webview's own resource table.
    pub fn created(&self, window: &str) -> Arc<Instance> {
        let instance = Instance::new();
        let mut by_window = lock(&self.by_window);
        by_window.retain(|(_, known)| known.strong_count() > 0);
        by_window.push((window.to_string(), Arc::downgrade(&instance)));
        instance
    }

    /// `window` was destroyed. Every instance recorded for it is over. This
    /// needs nothing from Tauri's manager, which has already forgotten them.
    ///
    /// Tauri handles a window's destruction and announces its successor on
    /// the main thread, in that order, so the instances recorded for a label
    /// when its `Destroyed` arrives are the destroyed window's.
    pub fn window_destroyed(&self, window: &str) {
        let gone: Vec<Arc<Instance>> = {
            let mut by_window = lock(&self.by_window);
            let mut gone = Vec::new();
            by_window.retain(|(owner, instance)| {
                if owner != window {
                    return instance.strong_count() > 0;
                }
                gone.extend(instance.upgrade());
                false
            });
            gone
        };
        for instance in gone {
            instance.end();
        }
    }
}
