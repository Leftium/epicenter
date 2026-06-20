import { expect, test } from 'bun:test';
import type { KeyBinding } from '$lib/tauri/commands';
import { type CommandReach, createReachRouter } from './reach-router';
import type { Shortcuts } from './types';

/**
 * The catalog slice the router reads. A `focused` and a `global` command are
 * enough to exercise routing in both reach directions; the full command-ceiling
 * clamp (a chord on a `focused` command) is pinned by `realizedReach`'s own
 * tests, so here it only needs to prove the router consults `command.reach`.
 */
const CATALOG: readonly CommandReach[] = [
	{ id: 'toggleManualRecording', reach: 'global' },
	{ id: 'pushToTalk', reach: 'global' },
];

/**
 * A `Shortcuts` test double that stores bindings in a map and records the calls
 * the router delegates to it. `conflict` is the canned `findConflict` reason, so
 * a test can prove which backend a conflict check was routed into.
 */
function fakeShortcuts(conflict: string | null = null) {
	const store = new Map<string, KeyBinding | null>();
	const calls = {
		set: [] as Array<[string, KeyBinding]>,
		clear: [] as string[],
		sync: 0,
		reset: 0,
	};
	const surface: Shortcuts = {
		async sync() {
			calls.sync++;
		},
		reset() {
			calls.reset++;
		},
		defaultLabel: () => '',
		currentLabel: () => '',
		current: (id) => store.get(id) ?? null,
		async set(id, binding) {
			store.set(id, binding);
			calls.set.push([id, binding]);
		},
		async clear(id) {
			store.set(id, null);
			calls.clear.push(id);
		},
		findConflict: () => conflict,
	};
	return { surface, store, calls };
}

const CHORD: KeyBinding = { modifiers: ['meta', 'shift'], keys: ['space'] };
const BARE: KeyBinding = { modifiers: [], keys: ['space'] };
const FN_HOLD: KeyBinding = { modifiers: ['fn'], keys: [] };

test('a chord on a global command routes the write to the global store (desktop)', async () => {
	const focused = fakeShortcuts();
	const global = fakeShortcuts();
	const router = createReachRouter({
		focused: focused.surface,
		global: global.surface,
		commands: CATALOG,
	});

	await router.set('toggleManualRecording', CHORD);

	expect(global.calls.set).toEqual([['toggleManualRecording', CHORD]]);
	expect(focused.calls.set).toEqual([]);
});

test('a bare key on a global command routes to the focused store (key ceiling, desktop)', async () => {
	const focused = fakeShortcuts();
	const global = fakeShortcuts();
	const router = createReachRouter({
		focused: focused.surface,
		global: global.surface,
		commands: CATALOG,
	});

	await router.set('toggleManualRecording', BARE);

	expect(focused.calls.set).toEqual([['toggleManualRecording', BARE]]);
	expect(global.calls.set).toEqual([]);
});

test('an Fn hold routes global and its badge needs Accessibility (desktop)', async () => {
	const focused = fakeShortcuts();
	const global = fakeShortcuts();
	const router = createReachRouter({
		focused: focused.surface,
		global: global.surface,
		commands: CATALOG,
	});

	expect(router.reachBadge('pushToTalk', FN_HOLD)).toEqual({
		reach: 'global',
		needsAccessibility: true,
	});

	await router.set('pushToTalk', FN_HOLD);
	expect(global.calls.set).toEqual([['pushToTalk', FN_HOLD]]);
});

test('web has no global backend, so the platform ceiling clamps every write to focused', async () => {
	const focused = fakeShortcuts();
	const router = createReachRouter({
		focused: focused.surface,
		global: null,
		commands: CATALOG,
	});

	// A chord buys nothing on web: min(global, global, focused) = focused.
	expect(router.reachBadge('toggleManualRecording', CHORD)).toEqual({
		reach: 'focused',
		needsAccessibility: false,
	});

	await router.set('toggleManualRecording', CHORD);
	expect(focused.calls.set).toEqual([['toggleManualRecording', CHORD]]);
});

test('clear targets the named slot', async () => {
	const focused = fakeShortcuts();
	const global = fakeShortcuts();
	const router = createReachRouter({
		focused: focused.surface,
		global: global.surface,
		commands: CATALOG,
	});

	await router.clear('toggleManualRecording', 'global');
	expect(global.calls.clear).toEqual(['toggleManualRecording']);
	expect(focused.calls.clear).toEqual([]);

	await router.clear('toggleManualRecording', 'focused');
	expect(focused.calls.clear).toEqual(['toggleManualRecording']);
});

test('clearing the global slot is a no-op on web', async () => {
	const focused = fakeShortcuts();
	const router = createReachRouter({
		focused: focused.surface,
		global: null,
		commands: CATALOG,
	});

	await router.clear('toggleManualRecording', 'global');
	expect(focused.calls.clear).toEqual([]);
});

test('current returns both slots', () => {
	const focused = fakeShortcuts();
	const global = fakeShortcuts();
	focused.store.set('toggleManualRecording', BARE);
	global.store.set('toggleManualRecording', CHORD);
	const router = createReachRouter({
		focused: focused.surface,
		global: global.surface,
		commands: CATALOG,
	});

	expect(router.current('toggleManualRecording')).toEqual({
		focused: BARE,
		global: CHORD,
	});
});

test('current reports a null global slot on web', () => {
	const focused = fakeShortcuts();
	focused.store.set('toggleManualRecording', BARE);
	const router = createReachRouter({
		focused: focused.surface,
		global: null,
		commands: CATALOG,
	});

	expect(router.current('toggleManualRecording')).toEqual({
		focused: BARE,
		global: null,
	});
});

test('findConflict is checked against the store the key would route into', () => {
	const focused = fakeShortcuts('focused conflict');
	const global = fakeShortcuts('global conflict');
	const router = createReachRouter({
		focused: focused.surface,
		global: global.surface,
		commands: CATALOG,
	});

	// A chord routes global, so the global policy answers.
	expect(router.findConflict('toggleManualRecording', CHORD)).toBe(
		'global conflict',
	);
	// A bare key routes focused, so the focused policy answers.
	expect(router.findConflict('toggleManualRecording', BARE)).toBe(
		'focused conflict',
	);
});

test('sync pushes both backends; reset resets both (desktop)', async () => {
	const focused = fakeShortcuts();
	const global = fakeShortcuts();
	const router = createReachRouter({
		focused: focused.surface,
		global: global.surface,
		commands: CATALOG,
	});

	await router.sync();
	expect(focused.calls.sync).toBe(1);
	expect(global.calls.sync).toBe(1);

	router.reset();
	expect(focused.calls.reset).toBe(1);
	expect(global.calls.reset).toBe(1);
});

test('sync and reset touch only the focused backend on web', async () => {
	const focused = fakeShortcuts();
	const router = createReachRouter({
		focused: focused.surface,
		global: null,
		commands: CATALOG,
	});

	await router.sync();
	router.reset();

	expect(focused.calls.sync).toBe(1);
	expect(focused.calls.reset).toBe(1);
});
