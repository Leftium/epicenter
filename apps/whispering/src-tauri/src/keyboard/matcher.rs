use std::collections::BTreeSet;

use super::event::{ShortcutTriggerEvent, TriggerState};
use super::keys::{Key, KeyBinding, Modifier};

/// How long a shorter binding waits to see whether a longer binding that extends
/// it completes. Kept small so a deliberate push-to-talk hold starts capturing
/// almost immediately; long enough that pressing the extra key of a chord (for
/// example the Space in `Fn` + `Space`) lands inside the window on real hardware.
/// See the module note on the first-syllable trade-off.
pub const PENDING_WINDOW_MS: u64 = 120;

/// Edge of a single key event fed in from the rdev listener.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Edge {
    Press,
    Release,
}

/// One normalized key, classified as a modifier or a regular key by the rdev
/// mapping layer (`rdev_map`) before it reaches the matcher. The matcher never
/// sees an `rdev::Key`, which is what keeps it pure and unit-testable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Input {
    Modifier(Modifier),
    Key(Key),
}

/// One registered binding. Order-independent sets are precomputed so matching is
/// a set comparison, not a `Vec` scan.
struct Registered {
    command_id: String,
    modifiers: BTreeSet<Modifier>,
    keys: BTreeSet<Key>,
}

/// The single in-flight gesture. The desktop backend resolves **one** gesture at
/// a time: a global push-to-talk hold owns the keyboard until it releases, so we
/// never track two bindings as simultaneously held (that is what lets a
/// resolved push-to-talk ignore extra keys instead of converting into a chord).
enum Gesture {
    /// Nothing held that matches or prefixes a binding.
    Idle,
    /// `index`'s binding is held exactly, but a longer binding extends it, so we
    /// wait until `deadline` (a logical millisecond timestamp) to see if the
    /// longer one completes. The listener schedules a `poll` for `deadline`.
    Pending { index: usize, deadline: u64 },
    /// `index`'s binding has fired `Pressed` and owns the gesture. It stays
    /// active (extra keys ignored) until one of its own keys releases.
    Active { index: usize },
}

/// Turns the rdev event stream into `{ command_id, state }` transitions with a
/// **gesture resolver** for prefix bindings.
///
/// Matching is still set-based: a binding is "held exactly" iff the held
/// modifiers equal its modifiers and the held keys equal its keys. On top of
/// that, prefixes resolve through a short pending window so `Fn` (push-to-talk)
/// and `Fn` + `Space` (toggle) can both be bound even though `Fn` arrives before
/// `Space`:
///
/// - A binding that is held exactly and has **no** registered binding extending
///   it fires immediately (the common case: a chord, a modifier-only hold).
/// - A binding that is held exactly and **does** have a longer binding extending
///   it enters a pending window. If the longer binding completes during the
///   window it fires and the shorter one is suppressed; if the window expires the
///   shorter one fires.
/// - Once a binding is `Active`, it owns the gesture: pressing extra keys does
///   not release it or convert it into a different binding. It releases (exactly
///   once) when one of its own keys goes up.
///
/// First-syllable note: because `Fn` has an extender by default, push-to-talk
/// waits up to `PENDING_WINDOW_MS` before `Pressed`, which delays audio capture
/// by that much. The window is deliberately small, and it only applies when a
/// real prefix conflict is configured (clear the toggle binding and `Fn` fires
/// immediately). The proper fix (warm the recorder on the pending edge) is
/// tracked separately; see the recorder's pre-roll discussion.
pub struct Matcher {
    bindings: Vec<Registered>,
    held_modifiers: BTreeSet<Modifier>,
    held_keys: BTreeSet<Key>,
    gesture: Gesture,
    capturing: bool,
}

/// What one event produced: the transitions to emit now, plus the deadline of a
/// freshly-armed pending window (if any) so the listener can schedule a `poll`.
pub struct MatchOutcome {
    pub events: Vec<ShortcutTriggerEvent>,
    /// `Some(deadline)` only when this event *armed* a new pending window. The
    /// listener spawns a timer for `deadline`; `poll` is a no-op if the window
    /// was already resolved or superseded, so a late timer is harmless.
    pub pending_until: Option<u64>,
}

impl MatchOutcome {
    fn nothing() -> Self {
        Self {
            events: Vec::new(),
            pending_until: None,
        }
    }

    fn fired(events: Vec<ShortcutTriggerEvent>) -> Self {
        Self {
            events,
            pending_until: None,
        }
    }

    fn pending(deadline: u64) -> Self {
        Self {
            events: Vec::new(),
            pending_until: Some(deadline),
        }
    }
}

impl Matcher {
    pub fn new() -> Self {
        Self {
            bindings: Vec::new(),
            held_modifiers: BTreeSet::new(),
            held_keys: BTreeSet::new(),
            gesture: Gesture::Idle,
            capturing: false,
        }
    }

    /// Enter or leave capture mode. While capturing, `on_event` updates the held
    /// set but emits no triggers and arms no pending window; the listener reads
    /// `held_binding` instead and forwards it to the settings recorder. The
    /// in-flight gesture is reset so nothing is left half-fired across the
    /// mode switch.
    pub fn set_capturing(&mut self, capturing: bool) {
        self.capturing = capturing;
        self.gesture = Gesture::Idle;
    }

    pub fn is_capturing(&self) -> bool {
        self.capturing
    }

    /// The currently-held keys as a binding, for the recorder to accumulate.
    pub fn held_binding(&self) -> KeyBinding {
        KeyBinding {
            modifiers: self.held_modifiers.iter().copied().collect(),
            keys: self.held_keys.iter().copied().collect(),
        }
    }

    /// Drop all held state and the in-flight gesture. Called when the listener
    /// (re)enters `rdev::listen`: a prior attempt that exited may have missed a
    /// key-up, and a stale held modifier would otherwise wedge a binding "down"
    /// or suppress the next press.
    pub fn clear_held(&mut self) {
        self.held_modifiers.clear();
        self.held_keys.clear();
        self.gesture = Gesture::Idle;
    }

    /// Replace the full set of registered bindings. Empty bindings are dropped
    /// (they can never be "held"). The held sets are left untouched: the physical
    /// keys really are still down.
    ///
    /// Any in-flight gesture resets to `Idle` (its index points into the old vec,
    /// so it cannot survive the swap anyway). The FE only re-pushes between
    /// sessions, on launch, on a settings edit, or on reset, never while a global
    /// gesture is physically held, so there is no resolved gesture to carry across.
    pub fn set_bindings(&mut self, bindings: impl IntoIterator<Item = (String, KeyBinding)>) {
        self.bindings = bindings
            .into_iter()
            .filter(|(_, binding)| !binding.is_empty())
            .map(|(command_id, binding)| {
                let (modifiers, keys) = binding.sets();
                Registered {
                    command_id,
                    modifiers,
                    keys,
                }
            })
            .collect();
        self.gesture = Gesture::Idle;
    }

    /// Feed one key event. Updates the held sets, then resolves the gesture.
    pub fn on_event(&mut self, now: u64, edge: Edge, input: Input) -> MatchOutcome {
        // Apply the edge. `changed` is false for an auto-repeat press (the key is
        // already held) or a stray release of an absent key. Those are no-ops:
        // returning early keeps auto-repeat from re-firing a binding and, just as
        // importantly, from resetting a pending window on every repeat tick.
        let changed = match (edge, input) {
            (Edge::Press, Input::Modifier(m)) => self.held_modifiers.insert(m),
            (Edge::Release, Input::Modifier(m)) => self.held_modifiers.remove(&m),
            (Edge::Press, Input::Key(k)) => self.held_keys.insert(k),
            (Edge::Release, Input::Key(k)) => self.held_keys.remove(&k),
        };
        if !changed {
            return MatchOutcome::nothing();
        }

        // In capture mode the listener forwards `held_binding()` to the recorder;
        // it does not match registered bindings or arm pending windows.
        if self.capturing {
            return MatchOutcome::nothing();
        }

        match self.gesture {
            Gesture::Active { index } => self.on_event_active(index),
            Gesture::Pending { index, .. } => self.on_event_pending(index, edge, now),
            Gesture::Idle => self.on_event_idle(edge, now),
        }
    }

    /// A timer (scheduled by the listener for a pending window's deadline) calls
    /// this. If the window is still open and has expired, the shorter binding
    /// fires. Otherwise it is a no-op: the window may have already resolved (the
    /// longer binding completed, the keys released) or been superseded by a newer
    /// pending window with a later deadline.
    pub fn poll(&mut self, now: u64) -> Vec<ShortcutTriggerEvent> {
        let Gesture::Pending { index, deadline } = self.gesture else {
            return Vec::new();
        };
        if now < deadline {
            return Vec::new();
        }
        self.gesture = Gesture::Active { index };
        vec![self.press(index)]
    }

    /// Deadline of the open pending window, if any. Test-only state query used to
    /// assert a window armed; production schedules off `MatchOutcome::pending_until`
    /// returned by `on_event`, so this is compiled out of release builds.
    #[cfg(test)]
    fn pending_deadline(&self) -> Option<u64> {
        match self.gesture {
            Gesture::Pending { deadline, .. } => Some(deadline),
            _ => None,
        }
    }

    // ── Per-state handlers ────────────────────────────────────────────────────

    /// An active binding owns the gesture. Extra presses are ignored; it releases
    /// only when one of its own keys/modifiers goes up (so the held set is no
    /// longer a superset of the binding).
    fn on_event_active(&mut self, index: usize) -> MatchOutcome {
        if self.held_is_superset_of(index) {
            return MatchOutcome::nothing();
        }
        self.gesture = Gesture::Idle;
        MatchOutcome::fired(vec![self.release(index)])
    }

    /// A pending window is open for `index`. A press either completes a longer
    /// binding (resolve to it) or grows past the shorter one without matching
    /// anything (commit the shorter one). A release either ends the shorter
    /// gesture before it resolved (drop it: a sub-window tap is not a hold) or
    /// drops an unrelated extra key (stay pending).
    fn on_event_pending(&mut self, index: usize, edge: Edge, now: u64) -> MatchOutcome {
        match edge {
            Edge::Press => {
                if let Some(exact) = self.find_exact() {
                    // The held set grew to exactly match another binding. Because
                    // the shorter binding was held exactly a moment ago and we only
                    // added keys, that binding necessarily extends it. Resolve to
                    // it (which may itself pend if it has a longer extender).
                    self.activate_or_pend(exact, now)
                } else {
                    // Grew past the shorter binding without matching anything. The
                    // shorter binding is still held (a subset), so commit it.
                    self.gesture = Gesture::Active { index };
                    MatchOutcome::fired(vec![self.press(index)])
                }
            }
            Edge::Release => {
                if self.held_is_superset_of(index) {
                    // An extra key went up but the shorter binding is still fully
                    // held; keep waiting. No new pending window is armed.
                    MatchOutcome::nothing()
                } else {
                    // One of the shorter binding's own keys went up before the
                    // window expired: a tap too brief to be a hold. Drop it rather
                    // than fire a near-empty push-to-talk.
                    self.gesture = Gesture::Idle;
                    MatchOutcome::nothing()
                }
            }
        }
    }

    /// Nothing in flight. A press that exactly matches a binding resolves it; a
    /// press that only partially builds a chord waits silently.
    fn on_event_idle(&mut self, edge: Edge, now: u64) -> MatchOutcome {
        if edge == Edge::Press {
            if let Some(index) = self.find_exact() {
                return self.activate_or_pend(index, now);
            }
        }
        MatchOutcome::nothing()
    }

    // ── Resolution helpers ────────────────────────────────────────────────────

    /// Resolve a binding that is currently held exactly: pend if a longer binding
    /// extends it, otherwise fire it now.
    fn activate_or_pend(&mut self, index: usize, now: u64) -> MatchOutcome {
        if self.has_extender(index) {
            let deadline = now + PENDING_WINDOW_MS;
            self.gesture = Gesture::Pending { index, deadline };
            MatchOutcome::pending(deadline)
        } else {
            self.gesture = Gesture::Active { index };
            MatchOutcome::fired(vec![self.press(index)])
        }
    }

    /// First binding whose modifier and key sets equal the held sets exactly.
    /// First-wins makes a duplicate binding (two commands on the same combo)
    /// resolve deterministically to the one registered earlier, and fires a
    /// single command rather than both.
    fn find_exact(&self) -> Option<usize> {
        self.bindings
            .iter()
            .position(|b| b.modifiers == self.held_modifiers && b.keys == self.held_keys)
    }

    /// Whether any *other* registered binding strictly extends `index`'s binding
    /// (a superset of both its modifiers and its keys). `index`'s binding is held
    /// exactly when this is called, so such a binding is reachable by pressing
    /// more keys, which is exactly the prefix conflict the window disambiguates.
    fn has_extender(&self, index: usize) -> bool {
        let target = &self.bindings[index];
        self.bindings.iter().enumerate().any(|(i, b)| {
            i != index
                && target.modifiers.is_subset(&b.modifiers)
                && target.keys.is_subset(&b.keys)
                // Strict: an equal binding (a duplicate combo) is a subset but not
                // an extender, so a duplicate fires immediately rather than pending
                // forever on a longer binding that does not exist.
                && (b.modifiers.len() + b.keys.len()) > (target.modifiers.len() + target.keys.len())
        })
    }

    /// Whether the held set still contains all of `index`'s modifiers and keys
    /// (extra held keys allowed). This is the "still held" test for an active
    /// binding: it tolerates extra keys so a resolved gesture is not broken by
    /// later presses.
    fn held_is_superset_of(&self, index: usize) -> bool {
        let b = &self.bindings[index];
        b.modifiers.is_subset(&self.held_modifiers) && b.keys.is_subset(&self.held_keys)
    }

    fn press(&self, index: usize) -> ShortcutTriggerEvent {
        ShortcutTriggerEvent {
            command_id: self.bindings[index].command_id.clone(),
            state: TriggerState::Pressed,
        }
    }

    fn release(&self, index: usize) -> ShortcutTriggerEvent {
        ShortcutTriggerEvent {
            command_id: self.bindings[index].command_id.clone(),
            state: TriggerState::Released,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding(modifiers: &[Modifier], keys: &[Key]) -> KeyBinding {
        KeyBinding {
            modifiers: modifiers.to_vec(),
            keys: keys.to_vec(),
        }
    }

    /// A logical clock for the event sequence. Each event advances time by
    /// `step` ms, so tests can place key presses inside or outside the pending
    /// window without any real sleeping.
    struct Clock {
        now: u64,
        step: u64,
    }

    /// Drive a sequence of events through the matcher and collect every emitted
    /// transition as `(command_id, state)` pairs. `poll` is run after each event
    /// once the clock has passed the pending deadline, mirroring the listener's
    /// timer: in production a real timer fires `poll` at the deadline; here we
    /// fire it deterministically.
    fn run(
        matcher: &mut Matcher,
        clock: &mut Clock,
        events: &[(Edge, Input)],
    ) -> Vec<(String, TriggerState)> {
        let mut out = Vec::new();
        for &(edge, input) in events {
            let outcome = matcher.on_event(clock.now, edge, input);
            for ev in outcome.events {
                out.push((ev.command_id, ev.state));
            }
            clock.now += clock.step;
        }
        out
    }

    /// Advance the clock past any open pending deadline and flush it, the way the
    /// scheduled timer would.
    fn flush(matcher: &mut Matcher, clock: &mut Clock) -> Vec<(String, TriggerState)> {
        if let Some(deadline) = matcher.pending_deadline() {
            clock.now = clock.now.max(deadline);
        }
        matcher
            .poll(clock.now)
            .into_iter()
            .map(|ev| (ev.command_id, ev.state))
            .collect()
    }

    use Edge::{Press, Release};
    use Input::Key as K;
    use Input::Modifier as M;
    use Modifier::{Fn, Meta, Shift};
    use TriggerState::{Pressed, Released};

    fn fast() -> Clock {
        // 10ms per event: a whole short chord lands well inside the window.
        Clock { now: 0, step: 10 }
    }

    #[test]
    fn chord_fires_once_when_the_last_key_completes_it_and_releases_when_it_breaks() {
        let mut matcher = Matcher::new();
        matcher.set_bindings([(
            "pushToTalk".to_string(),
            binding(&[Meta, Shift], &[Key::KeyD]),
        )]);

        // Modifiers alone do not satisfy the chord; only the final key does. With
        // no binding extending Meta+Shift+D, it fires immediately on the D press.
        let events = run(
            &mut matcher,
            &mut fast(),
            &[
                (Press, M(Meta)),
                (Press, M(Shift)),
                (Press, K(Key::KeyD)),
                (Release, K(Key::KeyD)),
                (Release, M(Shift)),
                (Release, M(Meta)),
            ],
        );
        assert_eq!(
            events,
            vec![
                ("pushToTalk".to_string(), Pressed),
                ("pushToTalk".to_string(), Released),
            ]
        );
    }

    #[test]
    fn clear_held_drops_stale_state_so_a_missed_release_cannot_wedge_a_binding() {
        let mut matcher = Matcher::new();
        matcher.set_bindings([("ptt".to_string(), binding(&[], &[Key::Space]))]);
        let mut clock = fast();

        // Space goes down (binding fires), then the key-up is "missed" (the
        // listener exited mid-hold). clear_held models the listener restart.
        let pressed = run(&mut matcher, &mut clock, &[(Press, K(Key::Space))]);
        assert_eq!(pressed, vec![("ptt".to_string(), Pressed)]);
        matcher.clear_held();

        // A later stray release must not emit, and a fresh press still works.
        let after = run(
            &mut matcher,
            &mut clock,
            &[(Release, K(Key::Space)), (Press, K(Key::Space))],
        );
        assert_eq!(after, vec![("ptt".to_string(), Pressed)]);
    }

    #[test]
    fn modifier_order_does_not_matter() {
        let mut matcher = Matcher::new();
        matcher.set_bindings([("x".to_string(), binding(&[Meta, Shift], &[Key::KeyD]))]);
        // Shift before Meta still completes on KeyD.
        let events = run(
            &mut matcher,
            &mut fast(),
            &[(Press, M(Shift)), (Press, M(Meta)), (Press, K(Key::KeyD))],
        );
        assert_eq!(events, vec![("x".to_string(), Pressed)]);
    }

    #[test]
    fn modifier_only_binding_presses_and_releases_on_the_modifier_alone() {
        let mut matcher = Matcher::new();
        matcher.set_bindings([("toggle".to_string(), binding(&[Meta], &[]))]);
        let events = run(
            &mut matcher,
            &mut fast(),
            &[(Press, M(Meta)), (Release, M(Meta))],
        );
        assert_eq!(
            events,
            vec![
                ("toggle".to_string(), Pressed),
                ("toggle".to_string(), Released),
            ]
        );
    }

    #[test]
    fn single_key_push_to_talk_with_no_modifiers() {
        let mut matcher = Matcher::new();
        matcher.set_bindings([("ptt".to_string(), binding(&[], &[Key::Space]))]);
        let events = run(
            &mut matcher,
            &mut fast(),
            &[(Press, K(Key::Space)), (Release, K(Key::Space))],
        );
        assert_eq!(
            events,
            vec![("ptt".to_string(), Pressed), ("ptt".to_string(), Released)]
        );
    }

    #[test]
    fn fn_modifier_binding_fires() {
        let mut matcher = Matcher::new();
        matcher.set_bindings([("ptt".to_string(), binding(&[Fn], &[]))]);
        let events = run(
            &mut matcher,
            &mut fast(),
            &[(Press, M(Fn)), (Release, M(Fn))],
        );
        assert_eq!(
            events,
            vec![("ptt".to_string(), Pressed), ("ptt".to_string(), Released)]
        );
    }

    #[test]
    fn capture_mode_emits_no_triggers_and_held_binding_reflects_the_combo() {
        let mut matcher = Matcher::new();
        matcher.set_bindings([("ptt".to_string(), binding(&[], &[Key::Space]))]);
        matcher.set_capturing(true);

        // A registered binding must not fire while capturing.
        let events = run(
            &mut matcher,
            &mut fast(),
            &[(Press, M(Fn)), (Press, K(Key::KeyD))],
        );
        assert!(events.is_empty());

        // The held combo is what the recorder reads and commits (Fn + D, the
        // kind of binding the webview could never capture).
        let held = matcher.held_binding();
        assert_eq!(held.modifiers, vec![Fn]);
        assert_eq!(held.keys, vec![Key::KeyD]);

        // Leaving capture mode re-arms normal matching.
        matcher.set_capturing(false);
        let after = run(&mut matcher, &mut fast(), &[(Release, M(Fn))]);
        assert!(after.is_empty());
    }

    #[test]
    fn auto_repeat_does_not_re_emit_pressed() {
        let mut matcher = Matcher::new();
        matcher.set_bindings([("ptt".to_string(), binding(&[], &[Key::KeyD]))]);
        // A held key auto-repeats: rdev delivers KeyPress(KeyD) again. The
        // second and third press must not produce a second Pressed.
        let events = run(
            &mut matcher,
            &mut fast(),
            &[
                (Press, K(Key::KeyD)),
                (Press, K(Key::KeyD)),
                (Press, K(Key::KeyD)),
                (Release, K(Key::KeyD)),
            ],
        );
        assert_eq!(
            events,
            vec![("ptt".to_string(), Pressed), ("ptt".to_string(), Released)]
        );
    }

    #[test]
    fn empty_bindings_are_dropped_and_never_fire() {
        let mut matcher = Matcher::new();
        matcher.set_bindings([("noop".to_string(), binding(&[], &[]))]);
        // The all-released state must not be reported as a press for an empty
        // binding. Feeding an unrelated key produces nothing.
        let events = run(
            &mut matcher,
            &mut fast(),
            &[(Press, K(Key::KeyA)), (Release, K(Key::KeyA))],
        );
        assert!(events.is_empty());
    }

    #[test]
    fn two_bindings_track_independently() {
        let mut matcher = Matcher::new();
        matcher.set_bindings([
            ("a".to_string(), binding(&[Meta], &[Key::KeyA])),
            ("b".to_string(), binding(&[Meta], &[Key::KeyB])),
        ]);
        let events = run(
            &mut matcher,
            &mut fast(),
            &[
                (Press, M(Meta)),
                (Press, K(Key::KeyA)),   // a fires
                (Release, K(Key::KeyA)), // a releases
                (Press, K(Key::KeyB)),   // b fires
                (Release, K(Key::KeyB)), // b releases
            ],
        );
        assert_eq!(
            events,
            vec![
                ("a".to_string(), Pressed),
                ("a".to_string(), Released),
                ("b".to_string(), Pressed),
                ("b".to_string(), Released),
            ]
        );
    }

    #[test]
    fn re_pushing_bindings_resets_any_in_flight_gesture() {
        // The FE re-pushes the full set only between sessions, never while a
        // gesture is physically held, so a swap always restarts resolution from
        // Idle. A key still down when the swap lands does not emit on release:
        // the gesture that owned it is gone (even when the binding itself stays).
        let mut matcher = Matcher::new();
        matcher.set_bindings([("a".to_string(), binding(&[], &[Key::Space]))]);
        let mut clock = fast();
        let first = run(&mut matcher, &mut clock, &[(Press, K(Key::Space))]);
        assert_eq!(first, vec![("a".to_string(), Pressed)]);

        matcher.set_bindings([("a".to_string(), binding(&[], &[Key::Space]))]);
        let after = run(&mut matcher, &mut clock, &[(Release, K(Key::Space))]);
        assert!(after.is_empty());
    }

    // ── Gesture-resolver tests ────────────────────────────────────────────────

    /// Register the macOS default prefix pair: Fn = push-to-talk, Fn+Space =
    /// toggle. Fn is a prefix of Fn+Space, so Fn must wait out the window.
    fn fn_prefix_pair() -> Matcher {
        let mut matcher = Matcher::new();
        matcher.set_bindings([
            ("pushToTalk".to_string(), binding(&[Fn], &[])),
            ("toggle".to_string(), binding(&[Fn], &[Key::Space])),
        ]);
        matcher
    }

    #[test]
    fn fn_alone_resolves_to_push_to_talk_after_the_pending_window() {
        let mut matcher = fn_prefix_pair();
        let mut clock = fast();

        // Pressing Fn must NOT fire immediately: Fn+Space extends it.
        let pressed = run(&mut matcher, &mut clock, &[(Press, M(Fn))]);
        assert!(pressed.is_empty());
        assert!(matcher.pending_deadline().is_some());

        // When the window expires, push-to-talk fires (and only push-to-talk).
        let flushed = flush(&mut matcher, &mut clock);
        assert_eq!(flushed, vec![("pushToTalk".to_string(), Pressed)]);
    }

    #[test]
    fn fn_space_resolves_to_toggle_and_never_fires_push_to_talk() {
        let mut matcher = fn_prefix_pair();
        let mut clock = fast();

        // Fn then Space, both inside the window: the longer binding wins and the
        // shorter one is suppressed. No push-to-talk event ever appears.
        let events = run(
            &mut matcher,
            &mut clock,
            &[
                (Press, M(Fn)),
                (Press, K(Key::Space)),
                (Release, K(Key::Space)),
                (Release, M(Fn)),
            ],
        );
        assert_eq!(
            events,
            vec![
                ("toggle".to_string(), Pressed),
                ("toggle".to_string(), Released),
            ]
        );
        // A late timer firing now must do nothing.
        assert!(matcher.poll(clock.now + 1_000).is_empty());
    }

    #[test]
    fn releasing_fn_after_push_to_talk_emits_released_exactly_once() {
        let mut matcher = fn_prefix_pair();
        let mut clock = fast();

        run(&mut matcher, &mut clock, &[(Press, M(Fn))]);
        let pressed = flush(&mut matcher, &mut clock);
        assert_eq!(pressed, vec![("pushToTalk".to_string(), Pressed)]);

        // Exactly one Released on Fn up, and a stray timer afterwards adds nothing.
        let released = run(&mut matcher, &mut clock, &[(Release, M(Fn))]);
        assert_eq!(released, vec![("pushToTalk".to_string(), Released)]);
        assert!(matcher.poll(clock.now + 1_000).is_empty());
    }

    #[test]
    fn pressing_an_extra_key_after_push_to_talk_resolves_does_not_convert_it() {
        let mut matcher = fn_prefix_pair();
        let mut clock = fast();

        // Resolve to push-to-talk first.
        run(&mut matcher, &mut clock, &[(Press, M(Fn))]);
        let pressed = flush(&mut matcher, &mut clock);
        assert_eq!(pressed, vec![("pushToTalk".to_string(), Pressed)]);

        // Now press Space. The held set is exactly Fn+Space (toggle), but the
        // already-active push-to-talk owns the gesture: no toggle, no release.
        let extra = run(
            &mut matcher,
            &mut clock,
            &[(Press, K(Key::Space)), (Release, K(Key::Space))],
        );
        assert!(extra.is_empty());

        // Releasing Fn still ends push-to-talk exactly once.
        let released = run(&mut matcher, &mut clock, &[(Release, M(Fn))]);
        assert_eq!(released, vec![("pushToTalk".to_string(), Released)]);
    }

    #[test]
    fn a_prefix_binding_with_no_extender_fires_immediately() {
        // Same Fn push-to-talk, but no toggle registered: nothing extends Fn, so
        // it must fire on press with no window (no first-syllable penalty).
        let mut matcher = Matcher::new();
        matcher.set_bindings([("pushToTalk".to_string(), binding(&[Fn], &[]))]);
        let mut clock = fast();

        let pressed = run(&mut matcher, &mut clock, &[(Press, M(Fn))]);
        assert_eq!(pressed, vec![("pushToTalk".to_string(), Pressed)]);
        assert!(matcher.pending_deadline().is_none());
    }

    #[test]
    fn a_quick_tap_inside_the_window_is_dropped_not_fired() {
        // Press and release Fn before the window expires. Too brief to be a hold,
        // and not a chord, so nothing fires (avoids a near-empty push-to-talk).
        let mut matcher = fn_prefix_pair();
        let mut clock = fast();

        let events = run(
            &mut matcher,
            &mut clock,
            &[(Press, M(Fn)), (Release, M(Fn))],
        );
        assert!(events.is_empty());
        assert!(matcher.poll(clock.now + 1_000).is_empty());
    }

    #[test]
    fn pressing_an_unrelated_key_inside_the_window_commits_the_shorter_binding() {
        // Fn pending, then a key that completes no binding. The shorter binding is
        // still held, so it commits rather than getting lost.
        let mut matcher = fn_prefix_pair();
        let mut clock = fast();

        let events = run(
            &mut matcher,
            &mut clock,
            &[(Press, M(Fn)), (Press, K(Key::KeyJ))],
        );
        assert_eq!(events, vec![("pushToTalk".to_string(), Pressed)]);

        // And it still releases cleanly when Fn goes up.
        let released = run(
            &mut matcher,
            &mut clock,
            &[(Release, K(Key::KeyJ)), (Release, M(Fn))],
        );
        assert_eq!(released, vec![("pushToTalk".to_string(), Released)]);
    }

    #[test]
    fn duplicate_bindings_on_the_same_combo_fire_only_the_first_registered() {
        let mut matcher = Matcher::new();
        matcher.set_bindings([
            ("first".to_string(), binding(&[Meta], &[Key::KeyD])),
            ("second".to_string(), binding(&[Meta], &[Key::KeyD])),
        ]);
        let events = run(
            &mut matcher,
            &mut fast(),
            &[(Press, M(Meta)), (Press, K(Key::KeyD))],
        );
        assert_eq!(events, vec![("first".to_string(), Pressed)]);
    }

    #[test]
    fn windows_ctrl_win_prefix_pair_resolves_like_the_fn_pair() {
        // The Windows defaults: Ctrl+Win = push-to-talk, Ctrl+Win+Space = toggle.
        let mut matcher = Matcher::new();
        matcher.set_bindings([
            (
                "pushToTalk".to_string(),
                binding(&[Modifier::Ctrl, Meta], &[]),
            ),
            (
                "toggle".to_string(),
                binding(&[Modifier::Ctrl, Meta], &[Key::Space]),
            ),
        ]);
        let mut clock = fast();

        // Ctrl then Win: partial, nothing fires and no window yet (Ctrl alone
        // matches no binding).
        let partial = run(&mut matcher, &mut clock, &[(Press, M(Modifier::Ctrl))]);
        assert!(partial.is_empty());
        assert!(matcher.pending_deadline().is_none());

        // Win completes Ctrl+Win exactly, which has an extender: pend.
        let armed = run(&mut matcher, &mut clock, &[(Press, M(Meta))]);
        assert!(armed.is_empty());
        assert!(matcher.pending_deadline().is_some());

        // Space inside the window resolves to toggle, not push-to-talk.
        let toggled = run(&mut matcher, &mut clock, &[(Press, K(Key::Space))]);
        assert_eq!(toggled, vec![("toggle".to_string(), Pressed)]);
    }
}
