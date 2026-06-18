import { expect, test } from 'bun:test';
import {
	type BindingLike,
	bindingsOverlap,
	keyBindingToAccelerator,
} from './key-binding';

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
	// Two gestures ship bound by default: toggle and cancel. Push-to-talk ships
	// unbound (opt into Fn behind the Accessibility tier), so it cannot collide.
	const toggle: BindingLike = { modifiers: ['meta', 'shift'], keys: ['space'] };
	const cancel: BindingLike = { modifiers: ['meta'], keys: ['dot'] };
	expect(bindingsOverlap(toggle, cancel)).toBe(false);
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

test('a chord maps to a global-hotkey accelerator', () => {
	// meta -> Super, space -> Space: the default macOS toggle. Modifiers emit in
	// the shared fixed order (shift before meta), which the parser accepts in any
	// order anyway.
	expect(
		keyBindingToAccelerator({ modifiers: ['meta', 'shift'], keys: ['space'] }),
	).toBe('Shift+Super+Space');
});

test('modifiers serialize in a fixed order regardless of input order', () => {
	expect(
		keyBindingToAccelerator({ modifiers: ['shift', 'ctrl'], keys: ['dot'] }),
	).toBe('Control+Shift+Period');
});

test('letter and digit keys map to Code tokens', () => {
	expect(keyBindingToAccelerator({ modifiers: ['ctrl'], keys: ['keyD'] })).toBe(
		'Control+KeyD',
	);
	expect(keyBindingToAccelerator({ modifiers: ['alt'], keys: ['num1'] })).toBe(
		'Alt+Digit1',
	);
});

test('an Fn binding is not a Tier-0 accelerator', () => {
	// Fn has no accelerator spelling; it belongs to the Tier-1 tap.
	expect(
		keyBindingToAccelerator({ modifiers: ['fn'], keys: ['space'] }),
	).toBeNull();
});

test('a modifier-only hold is not a Tier-0 accelerator', () => {
	expect(keyBindingToAccelerator({ modifiers: ['meta'], keys: [] })).toBeNull();
});

test('a bare key with no modifier is refused', () => {
	expect(keyBindingToAccelerator({ modifiers: [], keys: ['keyA'] })).toBeNull();
});
