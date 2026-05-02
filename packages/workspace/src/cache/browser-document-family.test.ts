/**
 * Browser Document Family Tests
 *
 * Verifies the browser document family owns child document identity, active
 * sync fanout, and local persistence cleanup.
 *
 * Key behaviors:
 * - Opening the same id deduplicates documents through createDisposableCache.
 * - Pause and reconnect fan out only to currently cached child sync controls.
 * - Cleanup runs the caller-supplied local data cleanup operation.
 * - Disposal unregisters child sync controls and family disposal flushes docs.
 */

import { expect, test } from 'bun:test';
import { createBrowserDocumentFamily } from './browser-document-family.js';

function createSyncControl() {
	const calls: string[] = [];
	return {
		calls,
		syncControl: {
			pause() {
				calls.push('pause');
			},
			reconnect() {
				calls.push('reconnect');
			},
		},
	};
}

function wait(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test('open deduplicates documents through createDisposableCache', () => {
	let builds = 0;
	const family = createBrowserDocumentFamily({
		create(id: string) {
			builds++;
			const document = {
				id,
				state: { value: id },
				[Symbol.dispose]() {},
			};
			return {
				document,
				syncControl: null,
			};
		},
		clearLocalData: async () => {},
		gcTime: Number.POSITIVE_INFINITY,
	});

	const first = family.open('a');
	const second = family.open('a');

	expect(first).not.toBe(second);
	expect(first.state).toBe(second.state);
	expect(builds).toBe(1);
});

test('pause calls only active child sync controls', () => {
	const one = createSyncControl();
	const two = createSyncControl();
	const syncControls = { one, two };
	const family = createBrowserDocumentFamily({
		create: (id: 'one' | 'two') => ({
			document: {
				id,
				[Symbol.dispose]() {},
			},
			syncControl: syncControls[id].syncControl,
		}),
		clearLocalData: async () => {},
		gcTime: 0,
	});

	const oneHandle = family.open('one');
	family.syncControl.pause();
	oneHandle[Symbol.dispose]();
	family.open('two');
	family.syncControl.pause();

	expect(one.calls).toEqual(['pause']);
	expect(two.calls).toEqual(['pause']);
});

test('reconnect calls only active child sync controls', () => {
	const one = createSyncControl();
	const two = createSyncControl();
	const syncControls = { one, two };
	const family = createBrowserDocumentFamily({
		create: (id: 'one' | 'two') => ({
			document: {
				id,
				[Symbol.dispose]() {},
			},
			syncControl: syncControls[id].syncControl,
		}),
		clearLocalData: async () => {},
		gcTime: 0,
	});

	const oneHandle = family.open('one');
	const twoHandle = family.open('two');
	family.syncControl.reconnect();
	oneHandle[Symbol.dispose]();
	family.syncControl.reconnect();
	twoHandle[Symbol.dispose]();
	family.syncControl.reconnect();

	expect(one.calls).toEqual(['reconnect']);
	expect(two.calls).toEqual(['reconnect', 'reconnect']);
});

test('disposing a handle eventually unregisters that child sync control', async () => {
	const child = createSyncControl();
	const family = createBrowserDocumentFamily({
		create: (id: string) => ({
			document: {
				id,
				[Symbol.dispose]() {},
			},
			syncControl: child.syncControl,
		}),
		clearLocalData: async () => {},
		gcTime: 1,
	});

	const handle = family.open('a');
	family.syncControl.pause();
	handle[Symbol.dispose]();
	await wait(5);
	family.syncControl.pause();

	expect(child.calls).toEqual(['pause']);
});

test('family disposal disposes active cached documents', () => {
	const disposed: string[] = [];
	const family = createBrowserDocumentFamily({
		create: (id: string) => ({
			document: {
				id,
				[Symbol.dispose]() {
					disposed.push(id);
				},
			},
			syncControl: null,
		}),
		clearLocalData: async () => {},
		gcTime: Number.POSITIVE_INFINITY,
	});

	family.open('a');
	family.open('b');
	family[Symbol.dispose]();

	expect(disposed.sort()).toEqual(['a', 'b']);
});

test('member with null syncControl gives family no-op pause and reconnect', () => {
	const family = createBrowserDocumentFamily({
		create: (id: string) => ({
			document: {
				id,
				[Symbol.dispose]() {},
			},
			syncControl: null,
		}),
		clearLocalData: async () => {},
	});

	family.open('a');

	expect(() => family.syncControl.pause()).not.toThrow();
	expect(() => family.syncControl.reconnect()).not.toThrow();
});

test('clearLocalData runs the supplied cleanup operation', async () => {
	const calls: string[] = [];
	const family = createBrowserDocumentFamily({
		create: (id: string) => ({
			document: {
				id,
				[Symbol.dispose]() {},
			},
			syncControl: null,
		}),
		clearLocalData: async () => {
			calls.push('clear');
		},
	});

	await family.clearLocalData();

	expect(calls).toEqual(['clear']);
});

test('clearLocalData pauses active child sync before clearing storage', async () => {
	const calls: string[] = [];
	const family = createBrowserDocumentFamily({
		create: (id: string) => ({
			document: {
				id,
				[Symbol.dispose]() {},
			},
			syncControl: {
				pause() {
					calls.push('pause');
				},
				reconnect() {
					calls.push('reconnect');
				},
			},
		}),
		clearLocalData: async () => {
			calls.push('clear');
		},
	});

	family.open('open');
	await family.clearLocalData();

	expect(calls).toEqual(['pause', 'clear']);
});

test('clearLocalData can clear unopened documents through the supplied operation', async () => {
	const documentIds = ['open', 'unopened'];
	const clearedIds: string[] = [];
	const family = createBrowserDocumentFamily({
		create: (id: string) => ({
			document: {
				id,
				[Symbol.dispose]() {},
			},
			syncControl: null,
		}),
		clearLocalData: async () => {
			clearedIds.push(...documentIds);
		},
	});

	const handle = family.open('open');
	await family.clearLocalData();
	handle[Symbol.dispose]();

	expect(clearedIds).toEqual(['open', 'unopened']);
});
