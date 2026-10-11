//! A transport a shell injects for one folder's transfers.
//!
//! Without one, `push` and `fetch` hand Git the folder's remote URL, as raw
//! Git would. With one, every transfer first asks it for a [`Relay`]: an
//! ephemeral URL Git talks to instead, and the way to retire it. The remote
//! the folder captured stays its canonical destination, recorded in `origin`
//! and in the snapshot; the relay URL is never stored anywhere.
//!
//! A relayed transfer runs with fixed controls (`git.rs`, `relayed`): no
//! hooks, no fsmonitor, no maintenance, no proxy, its destination pinned
//! against URL rewrites, and only HTTP allowed. A transport that holds a
//! credential keeps it on its own side of the relay, so Git and anything Git
//! runs never receive it.
//!
//! The relay is retired exactly once: when the transfer is cancelled, before
//! Git is stopped, so nothing in flight upstream outlives the cancellation;
//! when it fails; and when it completes. Retiring reports what the transport
//! saw go wrong, if anything, so a failure can say more than Git's status. A
//! report also means the transport could not confirm the transfer, because it
//! was already retired or its owner could not answer, so a transfer whose
//! retirement reports anything is never presented as done, whatever Git's
//! own exit status said.
//!
//! A relay URL is a capability for as long as the relay lives. It is in Git's
//! argument list and nowhere else: Git's output is redacted before anything
//! reads it ([`Relay::redact`]), tracing is off for relayed transfers, and
//! [`Relay`]'s `Debug` never prints it.

use std::fmt;
use std::path::Path;
use std::sync::Mutex;

/// The canonical destination a transport is started against.
pub use crate::git::Remote;

/// The one smart-HTTP service a transfer uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitService {
    /// Fetching: discovery and `git-upload-pack`.
    UploadPack,
    /// Pushing: discovery and `git-receive-pack`.
    ReceivePack,
}

impl GitService {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UploadPack => "git-upload-pack",
            Self::ReceivePack => "git-receive-pack",
        }
    }
}

type Retire = Box<dyn FnOnce() -> Option<String> + Send>;

/// One transfer's transport: the URL Git is given, retired once.
pub struct Relay {
    url: String,
    retire: Mutex<Option<Retire>>,
}

impl Relay {
    /// `retire` ends the transport and returns `None` only when the transport
    /// itself confirms the transfer ended cleanly; otherwise it reports what
    /// it saw fail or why it cannot say. It runs once, from [`Relay::retire`]
    /// or when the relay is dropped.
    pub fn new(
        url: impl Into<String>,
        retire: impl FnOnce() -> Option<String> + Send + 'static,
    ) -> Self {
        Self {
            url: url.into(),
            retire: Mutex::new(Some(Box::new(retire))),
        }
    }

    /// What Git is told to talk to. Never the canonical remote, and never to
    /// be shown: see [`Relay::redact`].
    pub fn url(&self) -> &str {
        &self.url
    }

    /// `text` with every spelling of this relay's capability removed: the
    /// whole URL becomes `replacement` (the canonical remote), and what is
    /// left of it, the URL without its scheme, its path, or any long path
    /// segment such as a token, becomes `[relay]`. Git and a hostile server
    /// can echo any of these in a diagnostic; the rest of the text is kept.
    pub fn redact(&self, text: &str, replacement: &str) -> String {
        let mut redacted = text.replace(&self.url, replacement);
        let without_scheme = self
            .url
            .split_once("://")
            .map_or(self.url.as_str(), |(_, rest)| rest);
        let path = without_scheme
            .find('/')
            .map_or("", |start| &without_scheme[start..]);
        let mut pieces = vec![without_scheme.to_string(), path.to_string()];
        pieces.extend(
            path.split('/')
                .filter(|segment| segment.len() >= 16)
                .map(str::to_string),
        );
        pieces.retain(|piece| piece.len() > 1);
        pieces.sort_by_key(|piece| std::cmp::Reverse(piece.len()));
        for piece in pieces {
            redacted = redacted.replace(&piece, "[relay]");
        }
        redacted
    }

    /// Retire the transport now. The first call reports what it saw fail;
    /// every later one, and the drop after it, does nothing.
    pub fn retire(&self) -> Option<String> {
        let retire = self
            .retire
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        retire.and_then(|retire| retire())
    }
}

impl Drop for Relay {
    fn drop(&mut self) {
        self.retire();
    }
}

impl fmt::Debug for Relay {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Relay")
            .field("url", &"[relay]")
            .finish_non_exhaustive()
    }
}

/// Where a folder's transfers get their relays.
pub trait Transport: Send + Sync + fmt::Debug {
    /// Start one transfer's relay for `service`, against `remote`, the
    /// destination the folder captured when it opened. `root` is the
    /// folder's canonical root; its owner holds the folder's lock, so
    /// anything read from it here is read under that lock.
    ///
    /// An error refuses the transfer before Git starts; editing is not
    /// affected.
    fn start(&self, root: &Path, remote: &Remote, service: GitService) -> Result<Relay, String>;
}

/// Join a Git failure with what the transport saw, when it saw something.
pub(crate) fn with_report(failure: String, report: Option<String>) -> String {
    match report {
        Some(report) => format!("{failure}. {report}"),
        None => failure,
    }
}
