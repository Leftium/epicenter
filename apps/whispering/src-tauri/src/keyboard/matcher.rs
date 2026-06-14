use std::collections::BTreeSet;

use super::event::{ShortcutTriggerEvent, TriggerState};
use super::keys::{Key, KeyBinding, Modifier};

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

/// One registered binding plus whether it is currently satisfied. `active` is
/// the edge memory: the matcher recomputes satisfaction after every event and
/// emits only on a transition (not-held -> held is `Pressed`, held -> not-held
/// is `Released`). This makes auto-repeat a no-op (re-pressing an already-held
/// key leaves `active` true) and makes the emit idempotent.
struct Registered {
    command_id: String,
    modifiers: BTreeSet<Modifier>,
    keys: BTreeSet<Key>,
    active: bool,
}

/// Tracks the set of currently-held modifiers and keys and turns the rdev event
/// stream into `{ command_id, state }` transitions. Matching is **exact set
/// equality**: a binding is held iff the held modifiers equal its modifiers and
/// the held keys equal its keys. This mirrors `local-shortcut-manager`'s
/// `arraysMatch` and the global plugin's exact-modifier behavior, so existing
/// chords keep firing identically. A consequence of exact match: pressing an
/// extra key while holding a binding releases it (held set no longer equal),
/// which is the established behavior, not a regression.
pub struct Matcher {
    bindings: Vec<Registered>,
    held_modifiers: BTreeSet<Modifier>,
    held_keys: BTreeSet<Key>,
    capturing: bool,
}

impl Matcher {
    pub fn new() -> Self {
        Self {
            bindings: Vec::new(),
            held_modifiers: BTreeSet::new(),
            held_keys: BTreeSet::new(),
            capturing: false,
        }
    }

    /// Enter or leave capture mode. While capturing, `on_event` updates the held
    /// set but emits no triggers; the listener reads `held_binding` instead and
    /// forwards it to the settings recorder. Resets `active` flags so no binding
    /// is left half-fired across the mode switch.
    pub fn set_capturing(&mut self, capturing: bool) {
        self.capturing = capturing;
        for binding in &mut self.bindings {
            binding.active = false;
        }
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

    /// Drop all held state and mark every binding inactive. Called when the
    /// listener (re)enters `rdev::listen`: a prior attempt that exited may have
    /// missed a key-up, and a stale held modifier would otherwise wedge a
    /// binding "down" or suppress the next press under exact-set matching.
    pub fn clear_held(&mut self) {
        self.held_modifiers.clear();
        self.held_keys.clear();
        for binding in &mut self.bindings {
            binding.active = false;
        }
    }

    /// Replace the full set of registered bindings. Empty bindings are dropped
    /// (they can never be "held"). All `active` flags reset to false, so a
    /// freshly registered binding requires a new press even if its keys happen
    /// to be physically down at registration time. The held sets are left
    /// untouched: the physical keys really are still down.
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
                    active: false,
                }
            })
            .collect();
    }

    /// Feed one key event. Updates the held sets, then returns every binding
    /// that transitioned as a result (usually zero or one).
    pub fn on_event(&mut self, edge: Edge, input: Input) -> Vec<ShortcutTriggerEvent> {
        match (edge, input) {
            (Edge::Press, Input::Modifier(m)) => {
                self.held_modifiers.insert(m);
            }
            (Edge::Release, Input::Modifier(m)) => {
                self.held_modifiers.remove(&m);
            }
            (Edge::Press, Input::Key(k)) => {
                self.held_keys.insert(k);
            }
            (Edge::Release, Input::Key(k)) => {
                self.held_keys.remove(&k);
            }
        }

        // In capture mode the listener forwards `held_binding()` to the recorder;
        // it does not match registered bindings.
        if self.capturing {
            return Vec::new();
        }

        let mut events = Vec::new();
        for binding in &mut self.bindings {
            let satisfied =
                binding.modifiers == self.held_modifiers && binding.keys == self.held_keys;
            if satisfied && !binding.active {
                binding.active = true;
                events.push(ShortcutTriggerEvent {
                    command_id: binding.command_id.clone(),
                    state: TriggerState::Pressed,
                });
            } else if !satisfied && binding.active {
                binding.active = false;
                events.push(ShortcutTriggerEvent {
                    command_id: binding.command_id.clone(),
                    state: TriggerState::Released,
                });
            }
        }
        events
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

    /// Drive a sequence of events and collect every emitted transition as
    /// `(command_id, state)` pairs for terse assertions.
    fn run(matcher: &mut Matcher, events: &[(Edge, Input)]) -> Vec<(String, TriggerState)> {
        let mut out = Vec::new();
        for &(edge, input) in events {
            for ev in matcher.on_event(edge, input) {
                out.push((ev.command_id, ev.state));
            }
        }
        out
    }

    use Edge::{Press, Release};
    use Input::Key as K;
    use Input::Modifier as M;
    use Modifier::{Meta, Shift};
    use TriggerState::{Pressed, Released};

    #[test]
    fn chord_fires_once_when_the_last_key_completes_it_and_releases_when_it_breaks() {
        let mut matcher = Matcher::new();
        matcher.set_bindings([(
            "pushToTalk".to_string(),
            binding(&[Meta, Shift], &[Key::KeyD]),
        )]);

        // Modifiers alone do not satisfy the chord; only the final key does.
        let events = run(
            &mut matcher,
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

        // Space goes down (binding fires), then the key-up is "missed" (the
        // listener exited mid-hold). clear_held models the listener restart.
        let pressed = run(&mut matcher, &[(Press, K(Key::Space))]);
        assert_eq!(pressed, vec![("ptt".to_string(), Pressed)]);
        matcher.clear_held();

        // A later stray release must not emit, and a fresh press still works.
        let after = run(
            &mut matcher,
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
            &[(Press, M(Shift)), (Press, M(Meta)), (Press, K(Key::KeyD))],
        );
        assert_eq!(events, vec![("x".to_string(), Pressed)]);
    }

    #[test]
    fn modifier_only_binding_presses_and_releases_on_the_modifier_alone() {
        let mut matcher = Matcher::new();
        matcher.set_bindings([("toggle".to_string(), binding(&[Meta], &[]))]);
        let events = run(&mut matcher, &[(Press, M(Meta)), (Release, M(Meta))]);
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
        matcher.set_bindings([("ptt".to_string(), binding(&[Modifier::Fn], &[]))]);
        let events = run(
            &mut matcher,
            &[(Press, M(Modifier::Fn)), (Release, M(Modifier::Fn))],
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
            &[(Press, M(Modifier::Fn)), (Press, K(Key::KeyD))],
        );
        assert!(events.is_empty());

        // The held combo is what the recorder reads and commits (Fn + D, the
        // kind of binding the webview could never capture).
        let held = matcher.held_binding();
        assert_eq!(held.modifiers, vec![Modifier::Fn]);
        assert_eq!(held.keys, vec![Key::KeyD]);

        // Leaving capture mode re-arms normal matching.
        matcher.set_capturing(false);
        let after = run(&mut matcher, &[(Release, M(Modifier::Fn))]);
        assert!(after.is_empty());
    }

    #[test]
    fn auto_repeat_does_not_re_emit_pressed() {
        let mut matcher = Matcher::new();
        matcher.set_bindings([("ptt".to_string(), binding(&[], &[Key::KeyD]))]);
        // A held key auto-repeats: rdev delivers KeyPress(KeyD) again. The
        // second press must not produce a second Pressed.
        let events = run(
            &mut matcher,
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
    fn extra_modifier_breaks_exact_match_and_releases() {
        let mut matcher = Matcher::new();
        matcher.set_bindings([("x".to_string(), binding(&[Meta], &[Key::KeyD]))]);
        // Holding Meta+D fires; adding Shift makes the held modifier set no
        // longer equal {Meta}, so the binding releases (exact-match behavior).
        let events = run(
            &mut matcher,
            &[(Press, M(Meta)), (Press, K(Key::KeyD)), (Press, M(Shift))],
        );
        assert_eq!(
            events,
            vec![("x".to_string(), Pressed), ("x".to_string(), Released)]
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
    fn re_registering_bindings_resets_active_state() {
        let mut matcher = Matcher::new();
        matcher.set_bindings([("a".to_string(), binding(&[], &[Key::Space]))]);
        let first = run(&mut matcher, &[(Press, K(Key::Space))]);
        assert_eq!(first, vec![("a".to_string(), Pressed)]);

        // Re-register while Space is still physically held. The new binding set
        // starts inactive; releasing Space must not emit a Released for a
        // binding that was never marked active in this set.
        matcher.set_bindings([("a".to_string(), binding(&[], &[Key::Space]))]);
        let after = run(&mut matcher, &[(Release, K(Key::Space))]);
        assert!(after.is_empty());
    }
}
