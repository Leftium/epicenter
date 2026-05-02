/**
 * Browser Doc Cache Tests
 *
 * Verifies the browser doc cache owns child document identity, active
 * sync fanout, and local persistence cleanup.
 *
 * Key behaviors:
 * - Opening the same id deduplicates documents through createDisposableCache.
 * - Pause and reconnect fan out only to currently cached child sync controls.
 * - clearLocalData pauses active sync and clears every id from source.ids().
 * - clearLocalData clears unopened ids through source.clearLocalData(id)
 *   without constructing those documents.
 * - Disposal unregisters child sync controls and cache disposal flushes docs.
 */

import { expect, test } from 'bun:test';
import * as Y from 'yjs';
import type { SyncControl } from '../document/attach-sync.js';
import {
	type BrowserDocumentInstance,
	type BrowserDocumentFamilySource,
	createBrowserDocumentFamily,
} from './browser-document-family.js';

function createSyncControl() {
	const calls: string[] = [];
	const control: SyncControl = {
		pause() {
			calls.push('pause');
		},
		reconnect() {
			calls.push('reconnect');
		},
	};
	return { calls, control };
}

type TestDocument = BrowserDocumentInstance & {
	id: string;
};

function makeTestDocument(
	id: string,
	{
		sync,
		onDispose,
	}: { sync?: SyncControl | null; onDispose?: () => void } = {},
): TestDocument {
	const ydoc = new Y.Doc({ guid: `test-${id}`, gc: false });
	return {
		id,
		ydoc,
		sync: sync ?? null,
		[Symbol.dispose]() {
			onDispose?.();
			ydoc.destroy();
		},
	};
}

function wait(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test('open deduplicates documents through createDisposableCache', () => {
	let builds = 0;
	const source: BrowserDocumentFamilySource<string, TestDocument> = {
		ids: () => [],
		create(id) {
			builds++;
			return makeTestDocument(id);
		},
		clearLocalData: async () => {},
	};
	const cache = createBrowserDocumentFamily(source, {
		gcTime: Number.POSITIVE_INFINITY,
	});

	const first = cache.open('a');
	const second = cache.open('a');

	expect(first).not.toBe(second);
	expect(first.id).toBe(second.id);
	expect(first.ydoc).toBe(second.ydoc);
	expect(builds).toBe(1);
});

test('pause calls only active child sync controls', () => {
	const one = createSyncControl();
	const two = createSyncControl();
	const controls: Record<'one' | 'two', SyncControl> = {
		one: one.control,
		two: two.control,
	};
	const source: BrowserDocumentFamilySource<'one' | 'two', TestDocument> = {
		ids: () => [],
		create: (id) => makeTestDocument(id, { sync: controls[id] }),
		clearLocalData: async () => {},
	};
	const cache = createBrowserDocumentFamily(source, { gcTime: 0 });

	const oneHandle = cache.open('one');
	cache.syncControl.pause();
	oneHandle[Symbol.dispose]();
	cache.open('two');
	cache.syncControl.pause();

	expect(one.calls).toEqual(['pause']);
	expect(two.calls).toEqual(['pause']);
});

test('reconnect calls only active child sync controls', () => {
	const one = createSyncControl();
	const two = createSyncControl();
	const controls: Record<'one' | 'two', SyncControl> = {
		one: one.control,
		two: two.control,
	};
	const source: BrowserDocumentFamilySource<'one' | 'two', TestDocument> = {
		ids: () => [],
		create: (id) => makeTestDocument(id, { sync: controls[id] }),
		clearLocalData: async () => {},
	};
	const cache = createBrowserDocumentFamily(source, { gcTime: 0 });

	const oneHandle = cache.open('one');
	const twoHandle = cache.open('two');
	cache.syncControl.reconnect();
	oneHandle[Symbol.dispose]();
	cache.syncControl.reconnect();
	twoHandle[Symbol.dispose]();
	cache.syncControl.reconnect();

	expect(one.calls).toEqual(['reconnect']);
	expect(two.calls).toEqual(['reconnect', 'reconnect']);
});

test('disposing a handle eventually unregisters that child sync control', async () => {
	const child = createSyncControl();
	const source: BrowserDocumentFamilySource<string, TestDocument> = {
		ids: () => [],
		create: (id) => makeTestDocument(id, { sync: child.control }),
		clearLocalData: async () => {},
	};
	const cache = createBrowserDocumentFamily(source, { gcTime: 1 });

	const handle = cache.open('a');
	cache.syncControl.pause();
	handle[Symbol.dispose]();
	await wait(5);
	cache.syncControl.pause();

	expect(child.calls).toEqual(['pause']);
});

test('cache disposal disposes active cached documents', () => {
	const disposed: string[] = [];
	const source: BrowserDocumentFamilySource<string, TestDocument> = {
		ids: () => [],
		create: (id) =>
			makeTestDocument(id, { onDispose: () => disposed.push(id) }),
		clearLocalData: async () => {},
	};
	const cache = createBrowserDocumentFamily(source, {
		gcTime: Number.POSITIVE_INFINITY,
	});

	cache.open('a');
	cache.open('b');
	cache[Symbol.dispose]();

	expect(disposed.sort()).toEqual(['a', 'b']);
});

test('instance with null sync gives cache no-op pause and reconnect', () => {
	const source: BrowserDocumentFamilySource<string, TestDocument> = {
		ids: () => [],
		create: (id) => makeTestDocument(id, { sync: null }),
		clearLocalData: async () => {},
	};
	const cache = createBrowserDocumentFamily(source);

	cache.open('a');

	expect(() => cache.syncControl.pause()).not.toThrow();
	expect(() => cache.syncControl.reconnect()).not.toThrow();
});

test('clearLocalData calls source.clearLocalData(id) for every id from source.ids()', async () => {
	const cleared: string[] = [];
	const source: BrowserDocumentFamilySource<string, TestDocument> = {
		ids: () => ['a', 'b', 'c'],
		create: (id) => makeTestDocument(id),
		clearLocalData: async (id) => {
			cleared.push(id);
		},
	};
	const cache = createBrowserDocumentFamily(source);

	await cache.clearLocalData();

	expect(cleared.sort()).toEqual(['a', 'b', 'c']);
});

test('clearLocalData pauses active child sync before clearing storage', async () => {
	const calls: string[] = [];
	const control: SyncControl = {
		pause() {
			calls.push('pause');
		},
		reconnect() {
			calls.push('reconnect');
		},
	};
	const source: BrowserDocumentFamilySource<string, TestDocument> = {
		ids: () => ['open'],
		create: (id) => makeTestDocument(id, { sync: control }),
		clearLocalData: async (id) => {
			calls.push(`clear:${id}`);
		},
	};
	const cache = createBrowserDocumentFamily(source);

	cache.open('open');
	await cache.clearLocalData();

	expect(calls).toEqual(['pause', 'clear:open']);
});

test('clearLocalData clears unopened ids without constructing them', async () => {
	const created: string[] = [];
	const cleared: string[] = [];
	const source: BrowserDocumentFamilySource<string, TestDocument> = {
		ids: () => ['open', 'unopened'],
		create: (id) => {
			created.push(id);
			return makeTestDocument(id);
		},
		clearLocalData: async (id) => {
			cleared.push(id);
		},
	};
	const cache = createBrowserDocumentFamily(source);

	const handle = cache.open('open');
	await cache.clearLocalData();
	handle[Symbol.dispose]();

	expect(created).toEqual(['open']);
	expect(cleared.sort()).toEqual(['open', 'unopened']);
});
