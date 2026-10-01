//! One active pass and at most one pending pass, on a dedicated thread.
//!
//! An idle runner starts a request immediately; there is no quiet-period
//! timer. A request made while a pass is active joins the single pending
//! pass, which starts when the active one settles. The active pass may
//! already have read its inputs, so a request never joins it. Coalescing
//! bounds the backlog, not the pass frequency.
//!
//! Passes are numbered. A request returns the number of the pass that serves
//! it, and any caller can wait for that pass, so a window that goes away
//! leaves the pass running for the folder.

use std::collections::VecDeque;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};

/// How many settled results stay available to late waiters.
const RETAINED: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseMode {
    /// Let the active and pending passes run.
    Drain,
    /// Settle the pending pass as cancelled without running it and signal the
    /// active pass to stop; closing still waits for the active pass.
    Cancel,
}

/// What a runner needs to turn every ending into a result; a pass never panics out.
pub struct Endings<T> {
    /// A pass that panicked.
    pub failed: fn(String) -> T,
    /// A request made after closing started.
    pub closed: fn() -> T,
    /// A pending pass cancelled by `close(Cancel)`.
    pub cancelled: fn() -> T,
}

struct State<T> {
    running: Option<u64>,
    queued: Option<u64>,
    next: u64,
    fenced: bool,
    stopped: bool,
    cancel: Arc<AtomicBool>,
    settled: VecDeque<(u64, T)>,
}

struct Shared<T> {
    state: Mutex<State<T>>,
    changed: Condvar,
    endings: Endings<T>,
}

impl<T> Shared<T> {
    fn lock(&self) -> MutexGuard<'_, State<T>> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn settle(state: &mut State<T>, pass: u64, result: T) {
        state.settled.push_back((pass, result));
        while state.settled.len() > RETAINED {
            state.settled.pop_front();
        }
    }
}

pub struct PassRunner<T> {
    shared: Arc<Shared<T>>,
    on_change: Arc<dyn Fn() + Send + Sync>,
}

impl<T: Clone + Send + 'static> PassRunner<T> {
    /// `run` receives a flag that is set when the pass should stop early.
    /// `on_change` is called, without any runner lock held, whenever
    /// `active` or `pending` may have changed.
    pub fn new(
        name: &str,
        endings: Endings<T>,
        run: impl Fn(&AtomicBool) -> T + Send + 'static,
        on_change: impl Fn() + Send + Sync + 'static,
    ) -> Self {
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                running: None,
                queued: None,
                next: 1,
                fenced: false,
                stopped: false,
                cancel: Arc::new(AtomicBool::new(false)),
                settled: VecDeque::new(),
            }),
            changed: Condvar::new(),
            endings,
        });
        let on_change: Arc<dyn Fn() + Send + Sync> = Arc::new(on_change);
        let worker = Arc::clone(&shared);
        let notify = Arc::clone(&on_change);
        std::thread::Builder::new()
            .name(format!("folder-{name}"))
            .spawn(move || loop {
                let (pass, cancel) = {
                    let mut state = worker.lock();
                    loop {
                        if let Some(pass) = state.queued.take() {
                            state.running = Some(pass);
                            state.cancel = Arc::new(AtomicBool::new(false));
                            break (pass, Arc::clone(&state.cancel));
                        }
                        if state.stopped {
                            return;
                        }
                        state = worker
                            .changed
                            .wait(state)
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                    }
                };
                notify();
                let result =
                    catch_unwind(AssertUnwindSafe(|| run(&cancel))).unwrap_or_else(|panic| {
                        let message = panic
                            .downcast_ref::<String>()
                            .cloned()
                            .or_else(|| panic.downcast_ref::<&str>().map(|text| text.to_string()))
                            .unwrap_or_else(|| "the pass panicked".to_string());
                        (worker.endings.failed)(message)
                    });
                {
                    let mut state = worker.lock();
                    state.running = None;
                    Shared::settle(&mut state, pass, result);
                }
                worker.changed.notify_all();
                notify();
            })
            .expect("a folder worker thread starts");
        Self { shared, on_change }
    }

    /// The number of the pass that starts at or after this request, or `None`
    /// once closing has started.
    pub fn request(&self) -> Option<u64> {
        let (pass, fresh) = {
            let mut state = self.shared.lock();
            if state.fenced {
                return None;
            }
            match state.queued {
                Some(pass) => (pass, false),
                None => {
                    let pass = state.next;
                    state.next += 1;
                    state.queued = Some(pass);
                    (pass, true)
                }
            }
        };
        if fresh {
            self.shared.changed.notify_all();
            (self.on_change)();
        }
        Some(pass)
    }

    /// Block until the numbered pass settles.
    pub fn wait(&self, pass: u64) -> T {
        let mut state = self.shared.lock();
        loop {
            if let Some((_, result)) = state.settled.iter().find(|(settled, _)| *settled == pass) {
                return result.clone();
            }
            if state.running != Some(pass) && state.queued != Some(pass) {
                return (self.shared.endings.failed)(
                    "the result of this pass is no longer available".to_string(),
                );
            }
            state = self
                .shared
                .changed
                .wait(state)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }

    /// Request a pass and wait for it; the closed result once fenced.
    pub fn request_and_wait(&self) -> T {
        match self.request() {
            Some(pass) => self.wait(pass),
            None => (self.shared.endings.closed)(),
        }
    }

    pub fn active(&self) -> bool {
        self.shared.lock().running.is_some()
    }

    pub fn pending(&self) -> bool {
        self.shared.lock().queued.is_some()
    }

    /// Fence new requests and return once no pass is active or pending.
    pub fn close(&self, mode: CloseMode) {
        {
            let mut state = self.shared.lock();
            state.fenced = true;
            if mode == CloseMode::Cancel {
                if let Some(pass) = state.queued.take() {
                    let cancelled = (self.shared.endings.cancelled)();
                    Shared::settle(&mut state, pass, cancelled);
                }
                state.cancel.store(true, Ordering::SeqCst);
            }
            self.shared.changed.notify_all();
            while state.running.is_some() || state.queued.is_some() {
                state = self
                    .shared
                    .changed
                    .wait(state)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
            }
        }
        (self.on_change)();
    }
}

impl<T> Drop for PassRunner<T> {
    fn drop(&mut self) {
        self.shared.lock().stopped = true;
        self.shared.changed.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::mpsc;

    fn endings() -> Endings<String> {
        Endings {
            failed: |cause| format!("failed: {cause}"),
            closed: || "closed".to_string(),
            cancelled: || "cancelled".to_string(),
        }
    }

    #[test]
    fn requests_during_an_active_pass_share_one_pending_pass() {
        let (release, gate) = mpsc::channel::<()>();
        let gate = Mutex::new(gate);
        let runs = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&runs);
        let runner = PassRunner::new(
            "test",
            endings(),
            move |_| {
                let run = counter.fetch_add(1, Ordering::SeqCst) + 1;
                gate.lock().unwrap().recv().unwrap();
                format!("pass {run}")
            },
            || {},
        );
        let first = runner.request().unwrap();
        while !runner.active() {
            std::thread::yield_now();
        }
        let second = runner.request().unwrap();
        let third = runner.request().unwrap();
        assert_ne!(first, second, "a request never joins the active pass");
        assert_eq!(second, third, "later requests share the pending pass");
        assert!(runner.pending());
        release.send(()).unwrap();
        assert_eq!(runner.wait(first), "pass 1");
        release.send(()).unwrap();
        assert_eq!(runner.wait(second), "pass 2");
        assert_eq!(runs.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn drain_runs_the_pending_pass_and_cancel_does_not() {
        for (mode, expected) in [(CloseMode::Drain, "ran"), (CloseMode::Cancel, "cancelled")] {
            let (release, gate) = mpsc::channel::<()>();
            let gate = Mutex::new(gate);
            let runner = Arc::new(PassRunner::new(
                "test",
                endings(),
                move |cancel: &AtomicBool| {
                    while gate.lock().unwrap().try_recv().is_err() {
                        if cancel.load(Ordering::SeqCst) {
                            return "stopped".to_string();
                        }
                        std::thread::yield_now();
                    }
                    "ran".to_string()
                },
                || {},
            ));
            let first = runner.request().unwrap();
            while !runner.active() {
                std::thread::yield_now();
            }
            let pending = runner.request().unwrap();
            let closing = {
                let runner = Arc::clone(&runner);
                std::thread::spawn(move || runner.close(mode))
            };
            if mode == CloseMode::Drain {
                release.send(()).unwrap();
                release.send(()).unwrap();
                assert_eq!(runner.wait(first), "ran");
            } else {
                assert_eq!(runner.wait(first), "stopped");
            }
            closing.join().unwrap();
            assert_eq!(runner.wait(pending), expected);
            assert_eq!(runner.request(), None, "closing fences new requests");
            assert_eq!(runner.request_and_wait(), "closed");
        }
    }

    #[test]
    fn a_panicking_pass_settles_as_failed_and_the_runner_keeps_working() {
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&calls);
        let runner = PassRunner::new(
            "test",
            endings(),
            move |_| {
                if counter.fetch_add(1, Ordering::SeqCst) == 0 {
                    panic!("boom");
                }
                "ok".to_string()
            },
            || {},
        );
        assert_eq!(runner.request_and_wait(), "failed: boom");
        assert_eq!(runner.request_and_wait(), "ok");
    }
}
