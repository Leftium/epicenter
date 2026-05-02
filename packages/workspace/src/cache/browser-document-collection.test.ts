import { expect, test } from 'bun:test';
import { createBrowserDocumentCollection } from './browser-document-collection.js';

function createSync() {
	const calls: string[] = [];
	return {
		calls,
		sync: {
			whenConnected: Promise.resolve(),
			get status() {
				return { phase: 'offline' as const };
			},
			onStatusChange: () => () => {},
			pause: () => calls.push('pause'),
			reconnect: () => calls.push('reconnect'),
			whenDisposed: Promise.resolve(),
			attachRpc: () => ({
				rpc: async () => {
					throw new Error('unused');
				},
			}),
		},
	};
}

test('clears unopened child document stores from ids and guid', async () => {
	const cleared: string[] = [];
	const collection = createBrowserDocumentCollection({
		ids: () => ['a', 'b'],
		guid: (id) => `doc-${id}`,
		build: (id) => ({
			id,
			[Symbol.dispose]() {},
		}),
		clearLocalDataForGuid: async (guid) => {
			cleared.push(guid);
		},
	});

	await collection.clearLocalData();

	expect(cleared).toEqual(['doc-a', 'doc-b']);
});

test('disposal unregisters active child syncs', () => {
	const one = createSync();
	const two = createSync();
	const syncs = { one, two };
	const collection = createBrowserDocumentCollection({
		ids: () => ['one', 'two'],
		guid: (id) => id,
		build: (id: 'one' | 'two') => ({
			id,
			sync: syncs[id].sync,
			[Symbol.dispose]() {},
		}),
		sync: (document) => document.sync,
		clearLocalDataForGuid: async () => {},
		gcTime: 0,
	});

	const oneHandle = collection.open('one');
	const twoHandle = collection.open('two');
	collection.reconnect();

	oneHandle[Symbol.dispose]();
	collection.reconnect();

	twoHandle[Symbol.dispose]();
	collection.reconnect();

	expect(one.calls).toEqual(['reconnect']);
	expect(two.calls).toEqual(['reconnect', 'reconnect']);
});

test('collection disposal disposes active cached documents', () => {
	const disposed: string[] = [];
	const collection = createBrowserDocumentCollection({
		ids: () => ['a', 'b'],
		guid: (id) => id,
		build: (id) => ({
			id,
			[Symbol.dispose]() {
				disposed.push(id);
			},
		}),
		clearLocalDataForGuid: async () => {},
		gcTime: Number.POSITIVE_INFINITY,
	});

	collection.open('a');
	collection.open('b');
	collection[Symbol.dispose]();

	expect(disposed.sort()).toEqual(['a', 'b']);
});
