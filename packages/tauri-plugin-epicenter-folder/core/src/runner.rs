//! One active pass and at most one pending pass, on a dedicated thread.
//!
//! The owner runs scans, pushes, and fetches here: work that is serialized,
//! runs outside the file gate and the Git lock, and for the network can be
//! cancelled. Commits and fast-forwards are not passes; the owner's own gates
//! order them.
//!
//! An idle runner starts a request immediately; there is no quiet-period
//! timer. A request made while a pass is active joins the single pending
//! pass, which starts when the active one settles. The active pass may
//! already have read its inputs, so a request never joins it. Coalescing
//! bounds the backlog, not the pass frequency. An attempt starts a pass only
//! on an idle runner and is otherwise forgotten.
//!
//! A pass is admitted when the worker takes it, under the runner's lock. Until
//! then a caller that named a `Leaving` can withdraw, under the same lock, so
//! each request is either withdrawn or admitted and never both. A `Leaving`
//! belongs to one runner, and only that runner's lock reads or writes it. A
//! pending
//! pass whose callers all withdrew, and which nobody else is owed, is dropped
//! and never starts. Once a pass is admitted, withdrawing changes nothing: it
//! runs to its end for the folder.
//!
//! Passes are numbered so a requester can wait for the pass that serves it.
//! The numbers never leave this module.

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
    /// A caller that withdrew before the pass serving it started.
    pub withdrawn: fn() -> T,
}

/// One caller's way to withdraw a request whose pass has not started. It
/// belongs to the one runner that made it: that runner's lock is the only
/// place it is read or written, so whether the caller left, whether it is
/// still in the pending pass, and whether that pass was admitted are decided
/// together. A caller with requests on two runners holds one of these for
/// each; naming another runner's is a programming error.
#[derive(Debug)]
pub struct Leaving {
    /// The runner this belongs to.
    runner: usize,
    left: AtomicBool,
}

/// The pass that starts after the active one.
struct Queued {
    pass: u64,
    /// The callers waiting for it that may still withdraw.
    callers: Vec<Arc<Leaving>>,
    /// Someone who cannot withdraw asked for it, so it runs whoever leaves.
    owed: bool,
}

struct State<T> {
    running: Option<u64>,
    queued: Option<Queued>,
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
    /// `active` may have changed.
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
                        // Admission: from here the pass runs, whoever leaves.
                        if let Some(Queued { pass, .. }) = state.queued.take() {
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

    /// Start a pass only if none is active or pending and closing has not
    /// started. Nothing remembers an attempt that started none.
    pub fn attempt(&self) {
        {
            let mut state = self.shared.lock();
            if state.fenced || state.running.is_some() || state.queued.is_some() {
                return;
            }
            let pass = state.next;
            state.next += 1;
            state.queued = Some(Queued {
                pass,
                callers: Vec::new(),
                owed: true,
            });
        }
        self.shared.changed.notify_all();
        (self.on_change)();
    }

    fn identity(&self) -> usize {
        Arc::as_ptr(&self.shared) as *const () as usize
    }

    /// A way for one caller to withdraw from this runner, and from no other.
    pub fn leaving(&self) -> Arc<Leaving> {
        Arc::new(Leaving {
            runner: self.identity(),
            left: AtomicBool::new(false),
        })
    }

    /// Refuse another runner's `Leaving`: this runner's lock does not order it.
    fn own(&self, leaving: &Leaving) {
        assert_eq!(
            leaving.runner,
            self.identity(),
            "a Leaving is only used with the runner that made it"
        );
    }

    /// Join the pass that starts at or after this request. `Err` is the result
    /// of a request that joined none: closing had started, or `leaving` had
    /// already withdrawn. That check and the join are one step under the lock.
    fn join(&self, leaving: Option<&Arc<Leaving>>) -> Result<u64, T> {
        if let Some(leaving) = leaving {
            self.own(leaving);
        }
        let (pass, fresh) = {
            let mut state = self.shared.lock();
            if state.fenced {
                return Err((self.shared.endings.closed)());
            }
            if leaving.is_some_and(|leaving| leaving.left.load(Ordering::SeqCst)) {
                return Err((self.shared.endings.withdrawn)());
            }
            let fresh = state.queued.is_none();
            if fresh {
                let pass = state.next;
                state.next += 1;
                state.queued = Some(Queued {
                    pass,
                    callers: Vec::new(),
                    owed: false,
                });
            }
            let queued = state.queued.as_mut().expect("a pass is pending");
            match leaving {
                Some(leaving) => queued.callers.push(Arc::clone(leaving)),
                None => queued.owed = true,
            }
            (queued.pass, fresh)
        };
        if fresh {
            self.shared.changed.notify_all();
            (self.on_change)();
        }
        Ok(pass)
    }

    /// Ask for a pass nobody waits for and nobody can withdraw.
    pub fn request(&self) {
        let _ = self.join(None);
    }

    /// Withdraw `leaving` from the pending pass, if it is waiting for one, and
    /// from every later request that names it. A pending pass left with no
    /// caller, and owed to nobody, never starts. A pass already admitted is
    /// not affected.
    pub fn withdraw(&self, leaving: &Arc<Leaving>) {
        self.own(leaving);
        {
            let mut state = self.shared.lock();
            leaving.left.store(true, Ordering::SeqCst);
            if let Some(queued) = &mut state.queued {
                queued
                    .callers
                    .retain(|caller| !Arc::ptr_eq(caller, leaving));
                if queued.callers.is_empty() && !queued.owed {
                    state.queued = None;
                }
            }
        }
        self.shared.changed.notify_all();
    }

    /// Block until the numbered pass settles, or until `leaving` has withdrawn
    /// and the pass has not been admitted.
    fn wait(&self, pass: u64, leaving: Option<&Arc<Leaving>>) -> T {
        let mut state = self.shared.lock();
        loop {
            if let Some((_, result)) = state.settled.iter().find(|(settled, _)| *settled == pass) {
                return result.clone();
            }
            let queued = state
                .queued
                .as_ref()
                .is_some_and(|queued| queued.pass == pass);
            if state.running != Some(pass)
                && leaving.is_some_and(|leaving| leaving.left.load(Ordering::SeqCst))
            {
                return (self.shared.endings.withdrawn)();
            }
            if state.running != Some(pass) && !queued {
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

    /// Request a pass and wait for it. A caller that names a `Leaving` can
    /// withdraw until the pass is admitted; one that names none is owed it.
    pub fn request_and_wait(&self, leaving: Option<&Arc<Leaving>>) -> T {
        match self.join(leaving) {
            Ok(pass) => self.wait(pass, leaving),
            Err(refused) => refused,
        }
    }

    pub fn active(&self) -> bool {
        self.shared.lock().running.is_some()
    }

    /// Whether `leaving` is waiting in the pending pass, for tests that must
    /// act while it is.
    #[cfg(test)]
    pub(crate) fn pending(&self, leaving: &Arc<Leaving>) -> bool {
        self.shared.lock().queued.as_ref().is_some_and(|queued| {
            queued
                .callers
                .iter()
                .any(|caller| Arc::ptr_eq(caller, leaving))
        })
    }

    /// Fence new requests and return once no pass is active or pending.
    pub fn close(&self, mode: CloseMode) {
        {
            let mut state = self.shared.lock();
            state.fenced = true;
            if mode == CloseMode::Cancel {
                if let Some(Queued { pass, .. }) = state.queued.take() {
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
            withdrawn: || "withdrawn".to_string(),
        }
    }

    /// A runner whose every pass waits for one release, and how many started.
    fn held() -> (Arc<PassRunner<String>>, mpsc::Sender<()>, Arc<AtomicUsize>) {
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
        (Arc::new(runner), release, runs)
    }

    /// Start pass 1 for a caller that cannot withdraw, and wait until the
    /// worker has admitted it.
    fn hold_first(runner: &Arc<PassRunner<String>>) -> std::thread::JoinHandle<String> {
        let first = {
            let runner = Arc::clone(runner);
            std::thread::spawn(move || runner.request_and_wait(None))
        };
        while !runner.active() {
            std::thread::yield_now();
        }
        first
    }

    /// Ask for a pass on another thread as a caller that may withdraw, and
    /// wait until the runner has that caller in its pending pass.
    fn enqueue(
        runner: &Arc<PassRunner<String>>,
        leaving: &Arc<Leaving>,
    ) -> std::thread::JoinHandle<String> {
        let waiter = {
            let (runner, leaving) = (Arc::clone(runner), Arc::clone(leaving));
            std::thread::spawn(move || runner.request_and_wait(Some(&leaving)))
        };
        let waiting = || {
            runner.shared.lock().queued.as_ref().is_some_and(|queued| {
                queued
                    .callers
                    .iter()
                    .any(|caller| Arc::ptr_eq(caller, leaving))
            })
        };
        while !waiting() {
            std::thread::yield_now();
        }
        waiter
    }

    #[test]
    fn requests_during_an_active_pass_share_one_pending_pass() {
        let (runner, release, runs) = held();
        let first = runner.join(None).unwrap();
        while !runner.active() {
            std::thread::yield_now();
        }
        let second = runner.join(None).unwrap();
        let third = runner.join(None).unwrap();
        assert_ne!(first, second, "a request never joins the active pass");
        assert_eq!(second, third, "later requests share the pending pass");
        release.send(()).unwrap();
        assert_eq!(runner.wait(first, None), "pass 1");
        release.send(()).unwrap();
        assert_eq!(runner.wait(second, None), "pass 2");
        assert_eq!(runs.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_caller_withdrawn_before_its_pass_is_admitted_starts_none() {
        let (runner, release, runs) = held();
        let first = hold_first(&runner);

        // B is in the pending pass, behind the held one, when it withdraws.
        let b = runner.leaving();
        let waiting = enqueue(&runner, &b);
        runner.withdraw(&b);
        assert_eq!(waiting.join().unwrap(), "withdrawn");
        assert!(
            runner.shared.lock().queued.is_none(),
            "the pass nobody waits for is gone, and its caller with it"
        );
        // Withdrawing again, or asking again with the same handle, joins nothing.
        runner.withdraw(&b);
        assert_eq!(runner.request_and_wait(Some(&b)), "withdrawn");
        assert!(runner.shared.lock().queued.is_none());

        // A caller that withdrew before it ever asked joins nothing either.
        let early = runner.leaving();
        runner.withdraw(&early);
        assert_eq!(runner.request_and_wait(Some(&early)), "withdrawn");
        assert!(runner.shared.lock().queued.is_none());

        // The admitted pass finishes for its caller, and no other pass ran.
        release.send(()).unwrap();
        assert_eq!(first.join().unwrap(), "pass 1");
        {
            let state = runner.shared.lock();
            assert!(state.running.is_none() && state.queued.is_none());
        }
        assert_eq!(runs.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn withdrawing_one_caller_leaves_the_pass_its_other_callers_share() {
        let (runner, release, runs) = held();
        let first = hold_first(&runner);
        let (b, c) = (runner.leaving(), runner.leaving());
        let b_waiting = enqueue(&runner, &b);
        let c_waiting = enqueue(&runner, &c);

        runner.withdraw(&b);
        assert_eq!(b_waiting.join().unwrap(), "withdrawn");
        {
            let state = runner.shared.lock();
            let queued = state.queued.as_ref().expect("C still waits for its pass");
            assert_eq!(queued.callers.len(), 1);
            assert!(Arc::ptr_eq(&queued.callers[0], &c));
        }

        release.send(()).unwrap();
        assert_eq!(first.join().unwrap(), "pass 1");
        release.send(()).unwrap();
        assert_eq!(c_waiting.join().unwrap(), "pass 2");
        assert_eq!(runs.load(Ordering::SeqCst), 2, "C's pass ran exactly once");
    }

    #[test]
    fn a_pass_owed_to_someone_who_cannot_withdraw_survives_every_withdrawal() {
        let (runner, release, runs) = held();
        let first = hold_first(&runner);
        let b = runner.leaving();
        let b_waiting = enqueue(&runner, &b);
        // A scan or an owner-side caller asks for the same pending pass.
        runner.request();

        runner.withdraw(&b);
        assert_eq!(b_waiting.join().unwrap(), "withdrawn");
        {
            let state = runner.shared.lock();
            let queued = state
                .queued
                .as_ref()
                .expect("the owed pass is still pending");
            assert!(queued.owed && queued.callers.is_empty());
        }
        release.send(()).unwrap();
        assert_eq!(first.join().unwrap(), "pass 1");
        release.send(()).unwrap();
        assert_eq!(runner.wait(2, None), "pass 2");
        assert_eq!(runs.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn withdrawing_after_admission_changes_nothing_and_the_caller_gets_the_result() {
        let (runner, release, runs) = held();
        let a = runner.leaving();
        let waiting = {
            let (runner, a) = (Arc::clone(&runner), Arc::clone(&a));
            std::thread::spawn(move || runner.request_and_wait(Some(&a)))
        };
        while !runner.active() {
            std::thread::yield_now();
        }
        // The worker took the pass first: it is admitted. Withdrawing now
        // does not stop it, and its caller still hears how it ended.
        runner.withdraw(&a);
        assert!(runner.active());
        release.send(()).unwrap();
        assert_eq!(waiting.join().unwrap(), "pass 1");
        assert_eq!(runs.load(Ordering::SeqCst), 1);
    }

    #[test]
    #[should_panic(expected = "only used with the runner that made it")]
    fn a_runner_refuses_to_withdraw_another_runners_caller() {
        // Its lock would not order that caller's flag against the queue the
        // caller is waiting in.
        let (runner, _release, _runs) = held();
        let (other, _other_release, _other_runs) = held();
        other.withdraw(&runner.leaving());
    }

    #[test]
    #[should_panic(expected = "only used with the runner that made it")]
    fn a_runner_refuses_a_request_naming_another_runners_caller() {
        let (runner, _release, _runs) = held();
        let (other, _other_release, _other_runs) = held();
        other.request_and_wait(Some(&runner.leaving()));
    }

    #[test]
    fn an_attempt_starts_a_pass_only_on_an_idle_runner_and_is_otherwise_forgotten() {
        let (runner, release, runs) = held();
        runner.attempt();
        while !runner.active() {
            std::thread::yield_now();
        }
        // The pass is held. An attempt made now starts nothing, now or later.
        runner.attempt();
        release.send(()).unwrap();
        assert_eq!(runner.wait(1, None), "pass 1");
        // The worker settles a pass and clears `running` under one lock, and
        // only then takes a pending pass: one left behind would show here.
        {
            let state = runner.shared.lock();
            assert!(state.running.is_none() && state.queued.is_none());
        }
        assert_eq!(runs.load(Ordering::SeqCst), 1);

        runner.close(CloseMode::Drain);
        runner.attempt();
        assert!(
            runner.shared.lock().queued.is_none(),
            "closing fences attempts"
        );
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
            let first = runner.join(None).unwrap();
            while !runner.active() {
                std::thread::yield_now();
            }
            let pending = runner.join(None).unwrap();
            let closing = {
                let runner = Arc::clone(&runner);
                std::thread::spawn(move || runner.close(mode))
            };
            if mode == CloseMode::Drain {
                release.send(()).unwrap();
                release.send(()).unwrap();
                assert_eq!(runner.wait(first, None), "ran");
            } else {
                assert_eq!(runner.wait(first, None), "stopped");
            }
            closing.join().unwrap();
            assert_eq!(runner.wait(pending, None), expected);
            assert_eq!(
                runner.join(None),
                Err("closed".to_string()),
                "closing fences new requests"
            );
            assert_eq!(runner.request_and_wait(None), "closed");
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
        assert_eq!(runner.request_and_wait(None), "failed: boom");
        assert_eq!(runner.request_and_wait(None), "ok");
    }
}
