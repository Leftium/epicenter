//! Whether a window close or an application quit may go ahead.
//!
//! Drafts exist only in the page, so the page decides. The shell keeps three
//! facts and nothing about drafts:
//!
//! - Which page is loaded. A page registers when it starts, before it opens
//!   the notes folder, and gets a generation. A reload registers again and
//!   gets a new one; the generation before it can no longer answer.
//! - Whether that page opened its folder. Until it says so it holds no draft,
//!   and a close goes ahead: a page still loading, or one whose folder failed
//!   to open, has nothing to lose.
//! - Which close request the page is answering. Once the folder is open every
//!   close is asked, and only an approval that names the current page and the
//!   current request lets it go ahead. A declined request is finished; the
//!   next close is a new request.
//!
//! Nothing but that approval lets a close through while a page holds its
//! folder. A page that never answers, because its listener is missing or its
//! process died, is asked again on the next attempt and the window stays.
//!
//! Going ahead is final. The window is on its way out, so no page may open a
//! folder or register afterward.

use std::fmt;
use std::sync::{Mutex, MutexGuard};

use serde::Serialize;

/// A close request the page must answer. Sent to the page as it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Ask {
    pub generation: u64,
    pub request: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// Let the close or quit go ahead.
    Proceed,
    /// Hold it back and send this request to the page.
    Ask(Ask),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// The shell is already closing.
    Closing,
    /// The call names a page that a reload replaced, or one that never registered.
    StalePage,
    /// The call names a request that was declined, replaced, or never made.
    NoSuchRequest,
}

impl fmt::Display for Refusal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Refusal::Closing => "the app is already closing",
            Refusal::StalePage => "this page was replaced by a newer one",
            Refusal::NoSuchRequest => "this close request is no longer waiting for an answer",
        })
    }
}

struct Page {
    generation: u64,
    /// The page opened its folder, so it may hold drafts.
    open: bool,
    /// The request this page has been asked and has not answered.
    asking: Option<u64>,
}

#[derive(Default)]
struct State {
    generations: u64,
    requests: u64,
    page: Option<Page>,
    closing: bool,
}

impl State {
    /// The registered page, when `generation` names it.
    fn current(&mut self, generation: u64) -> Result<&mut Page, Refusal> {
        if self.closing {
            return Err(Refusal::Closing);
        }
        match self.page.as_mut() {
            Some(page) if page.generation == generation => Ok(page),
            _ => Err(Refusal::StalePage),
        }
    }

    /// The registered page, when it is being asked exactly `request`.
    fn asked(&mut self, generation: u64, request: u64) -> Result<&mut Page, Refusal> {
        let page = self.current(generation)?;
        if page.asking == Some(request) {
            Ok(page)
        } else {
            Err(Refusal::NoSuchRequest)
        }
    }
}

#[derive(Default)]
pub struct CloseGate {
    state: Mutex<State>,
}

impl CloseGate {
    pub fn new() -> Self {
        Self::default()
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// A page started. It replaces any page before it, along with that page's
    /// unanswered request.
    pub fn register_page(&self) -> Result<u64, Refusal> {
        let mut state = self.state();
        if state.closing {
            return Err(Refusal::Closing);
        }
        state.generations += 1;
        let generation = state.generations;
        state.page = Some(Page {
            generation,
            open: false,
            asking: None,
        });
        Ok(generation)
    }

    /// The page opened its folder. From here every close is asked. A refusal
    /// means the page must not show the folder.
    pub fn page_opened(&self, generation: u64) -> Result<(), Refusal> {
        self.state().current(generation)?.open = true;
        Ok(())
    }

    /// The window is closing or the app is quitting.
    pub fn request_close(&self) -> Decision {
        let mut state = self.state();
        if state.closing {
            return Decision::Proceed;
        }
        let next = state.requests + 1;
        let Some(page) = state.page.as_mut().filter(|page| page.open) else {
            state.closing = true;
            return Decision::Proceed;
        };
        let generation = page.generation;
        // An unanswered request is asked again under the same number, so a
        // page already answering it does not start a second answer.
        let request = *page.asking.get_or_insert(next);
        state.requests = state.requests.max(request);
        Decision::Ask(Ask {
            generation,
            request,
        })
    }

    /// The page saved every draft, or the person chose to discard them.
    pub fn approve(&self, generation: u64, request: u64) -> Result<(), Refusal> {
        let mut state = self.state();
        state.asked(generation, request)?;
        state.closing = true;
        Ok(())
    }

    /// The person chose to keep editing. The request is finished.
    pub fn decline(&self, generation: u64, request: u64) -> Result<(), Refusal> {
        self.state().asked(generation, request)?.asking = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn ask(gate: &CloseGate) -> Ask {
        match gate.request_close() {
            Decision::Ask(ask) => ask,
            Decision::Proceed => panic!("the close went ahead without the page"),
        }
    }

    fn open_page(gate: &CloseGate) -> u64 {
        let generation = gate.register_page().unwrap();
        gate.page_opened(generation).unwrap();
        generation
    }

    #[test]
    fn a_close_before_any_page_registered_proceeds() {
        let gate = CloseGate::new();
        assert_eq!(gate.request_close(), Decision::Proceed);
    }

    #[test]
    fn a_close_while_the_folder_is_opening_proceeds_and_refuses_the_late_open() {
        let gate = CloseGate::new();
        let generation = gate.register_page().unwrap();
        assert_eq!(gate.request_close(), Decision::Proceed);
        // The acquisition finishes after the close went ahead: no folder is shown.
        assert_eq!(gate.page_opened(generation), Err(Refusal::Closing));
        assert_eq!(gate.register_page(), Err(Refusal::Closing));
        assert_eq!(gate.request_close(), Decision::Proceed);
    }

    #[test]
    fn an_open_page_is_asked_and_only_its_approval_proceeds() {
        let gate = CloseGate::new();
        let generation = open_page(&gate);
        let asked = ask(&gate);
        assert_eq!(asked.generation, generation);
        gate.approve(asked.generation, asked.request).unwrap();
        // The window close and the exit that follows both go ahead.
        assert_eq!(gate.request_close(), Decision::Proceed);
        assert_eq!(gate.request_close(), Decision::Proceed);
        assert_eq!(
            gate.approve(asked.generation, asked.request),
            Err(Refusal::Closing)
        );
    }

    #[test]
    fn a_page_that_never_answers_is_asked_the_same_request_and_never_bypassed() {
        let gate = CloseGate::new();
        open_page(&gate);
        let first = ask(&gate);
        for _ in 0..50 {
            assert_eq!(ask(&gate), first);
        }
    }

    #[test]
    fn a_declined_request_cannot_be_approved_and_the_next_close_is_a_new_request() {
        let gate = CloseGate::new();
        open_page(&gate);
        let first = ask(&gate);
        gate.decline(first.generation, first.request).unwrap();
        assert_eq!(
            gate.approve(first.generation, first.request),
            Err(Refusal::NoSuchRequest)
        );
        assert_eq!(
            gate.decline(first.generation, first.request),
            Err(Refusal::NoSuchRequest)
        );
        let second = ask(&gate);
        assert_ne!(second.request, first.request);
        // The dialog of the first request is still on screen in the worst
        // case; its button names the first request and is refused.
        assert_eq!(
            gate.approve(first.generation, first.request),
            Err(Refusal::NoSuchRequest)
        );
        assert_eq!(ask(&gate), second);
        gate.approve(second.generation, second.request).unwrap();
        assert_eq!(gate.request_close(), Decision::Proceed);
    }

    #[test]
    fn an_approval_before_any_request_is_refused() {
        let gate = CloseGate::new();
        let generation = open_page(&gate);
        for request in 0..3 {
            assert_eq!(
                gate.approve(generation, request),
                Err(Refusal::NoSuchRequest)
            );
        }
        ask(&gate);
    }

    #[test]
    fn a_reload_replaces_the_page_and_its_unanswered_request() {
        let gate = CloseGate::new();
        open_page(&gate);
        let before = ask(&gate);
        // The reload starts a page that has not opened its folder.
        let reloaded = gate.register_page().unwrap();
        assert_ne!(reloaded, before.generation);
        assert_eq!(
            gate.approve(before.generation, before.request),
            Err(Refusal::StalePage)
        );
        assert_eq!(
            gate.decline(before.generation, before.request),
            Err(Refusal::StalePage)
        );
        assert_eq!(gate.page_opened(before.generation), Err(Refusal::StalePage));
        gate.page_opened(reloaded).unwrap();
        let after = ask(&gate);
        assert_eq!(after.generation, reloaded);
        assert_ne!(after.request, before.request);
        // The old page's request number under the new generation is not the
        // new page's request either.
        assert_eq!(
            gate.approve(reloaded, before.request),
            Err(Refusal::NoSuchRequest)
        );
        assert_eq!(ask(&gate), after);
    }

    #[test]
    fn a_reloaded_page_that_is_still_opening_lets_a_close_proceed() {
        let gate = CloseGate::new();
        open_page(&gate);
        ask(&gate);
        gate.register_page().unwrap();
        assert_eq!(gate.request_close(), Decision::Proceed);
    }

    #[test]
    fn a_page_that_never_registered_cannot_open_or_answer() {
        let gate = CloseGate::new();
        assert_eq!(gate.page_opened(1), Err(Refusal::StalePage));
        assert_eq!(gate.approve(1, 1), Err(Refusal::StalePage));
    }

    #[test]
    fn closes_from_many_threads_share_one_request_and_one_approval() {
        let gate = Arc::new(CloseGate::new());
        open_page(&gate);
        // Collected first, so every thread is running before any is joined.
        let asking: Vec<_> = (0..16)
            .map(|_| {
                let gate = Arc::clone(&gate);
                std::thread::spawn(move || ask(&gate))
            })
            .collect();
        let asks: Vec<Ask> = asking
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();
        assert!(asks.iter().all(|asked| *asked == asks[0]));
        let approving: Vec<_> = (0..16)
            .map(|_| {
                let (gate, asked) = (Arc::clone(&gate), asks[0]);
                std::thread::spawn(move || gate.approve(asked.generation, asked.request))
            })
            .collect();
        let approvals = approving
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .filter(Result::is_ok)
            .count();
        assert_eq!(approvals, 1);
    }
}
