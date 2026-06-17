import { expect, test } from 'bun:test';
import { type BindingLike, bindingsOverlap } from './key-binding';

test('a binding overlaps a superset of itself', () => {
	// Fn (push-to-talk) is contained by Fn+Space, so the pair is unusable.
	expect(
		bindingsOverlap(
			{ modifiers: ['fn'], keys: [] },
			{ modifiers: ['fn'], keys: ['space'] },
		),
	).toBe(true);
});

test('overlap is symmetric', () => {
	expect(
		bindingsOverlap(
			{ modifiers: ['fn'], keys: ['space'] },
			{ modifiers: ['fn'], keys: [] },
		),
	).toBe(true);
});

test('equal bindings overlap', () => {
	expect(
		bindingsOverlap(
			{ modifiers: ['meta'], keys: ['dot'] },
			{ modifiers: ['meta'], keys: ['dot'] },
		),
	).toBe(true);
});

test('a modifier-only hold is contained by any chord that adds to it', () => {
	expect(
		bindingsOverlap(
			{ modifiers: ['meta'], keys: [] },
			{ modifiers: ['meta'], keys: ['dot'] },
		),
	).toBe(true);
});

test('the shipped defaults do not overlap each other', () => {
	// Only two gestures ship bound by default: push-to-talk and cancel. Toggle
	// ships unbound (the in-app record button is its home), so it cannot collide.
	const pushToTalk: BindingLike = { modifiers: ['fn'], keys: [] };
	const cancel: BindingLike = { modifiers: ['meta'], keys: ['dot'] };
	expect(bindingsOverlap(pushToTalk, cancel)).toBe(false);
});

test('sibling chords sharing a modifier but differing in key do not overlap', () => {
	// Two Ctrl+Shift chords differing only in their final key (e.g. a user-bound
	// Ctrl+Shift+Space vs the Windows Ctrl+Shift+. cancel default).
	expect(
		bindingsOverlap(
			{ modifiers: ['ctrl', 'shift'], keys: ['space'] },
			{ modifiers: ['ctrl', 'shift'], keys: ['dot'] },
		),
	).toBe(false);
});
