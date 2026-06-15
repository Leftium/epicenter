/**
 * `attachLocalStorage` and `wipeLocalStorage` behavior tests.
 *
 * Covers the identity-scoped pairing of plaintext IDB persistence and
 * cross-tab BroadcastChannel, keyed by `(server, ownerId, ydoc.guid)`. Pins
 * the durable storage shape so any accidental change to the layout is
 * caught here:
 *
 *   epicenter/<server>/owners/<ownerId>/<guid>
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { asOwnerId } from '@epicenter/identity';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import * as Y from 'yjs';
import { attachLocalStorage } from './attach-local-storage.js';
import { wipeLocalStorage } from './wipe-local-storage.js';

Object.assign(globalThis, { indexedDB, IDBKeyRange });

const SERVER = 'api.epicenter.so';

function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

async function readUpdates(dbName: string): Promise<Uint8Array[]> {
	const db = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(dbName);
		request.onerror = () => reject(request.error);
		request.onsuccess = () => resolve(request.result);
	});
	try {
		const transaction = db.transaction(['updates'], 'readonly');
		const store = transaction.objectStore('updates');
		return await new Promise<Uint8Array[]>((resolve, reject) => {
			const request = store.getAll();
			request.onerror = () => reject(request.error);
			request.onsuccess = () => resolve(request.result as Uint8Array[]);
		});
	} finally {
		db.close();
	}
}

async function createDatabase(name: string): Promise<void> {
	const database = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(name);
		request.onerror = () => reject(request.error);
		request.onsuccess = () => resolve(request.result);
	});
	database.close();
}

async function deleteDatabase(name: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const request = indexedDB.deleteDatabase(name);
		request.onerror = () => reject(request.error);
		request.onsuccess = () => resolve();
		request.onblocked = () => reject(new Error(`Delete blocked for ${name}`));
	});
}

async function databaseNames(): Promise<string[]> {
	const databases = await indexedDB.databases();
	return databases
		.map((database) => database.name)
		.filter((name): name is string => typeof name === 'string');
}

describe('attachLocalStorage', () => {
	test('round trips Yjs updates through IndexedDB at the owner prefix', async () => {
		const userId = `user-${crypto.randomUUID()}`;
		const databaseName = `epicenter/${SERVER}/owners/${userId}/plaintext-idb-roundtrip`;

		const firstDoc = new Y.Doc({
			guid: 'plaintext-idb-roundtrip',
			gc: true,
		});
		const firstIdb = attachLocalStorage(firstDoc, {
			server: SERVER,
			ownerId: asOwnerId(userId),
		});
		await firstIdb.whenLoaded;
		firstDoc.getText('body').insert(0, 'stored text');
		await tick();
		firstDoc.destroy();
		await firstIdb.whenDisposed;

		const rawUpdates = await readUpdates(databaseName);
		expect(rawUpdates.length).toBeGreaterThan(0);
		expect(rawUpdates.every((update) => update instanceof Uint8Array)).toBe(
			true,
		);

		const secondDoc = new Y.Doc({
			guid: 'plaintext-idb-roundtrip',
			gc: true,
		});
		const secondIdb = attachLocalStorage(secondDoc, {
			server: SERVER,
			ownerId: asOwnerId(userId),
		});
		await secondIdb.whenLoaded;

		expect(secondDoc.getText('body').toString()).toBe('stored text');
		secondDoc.destroy();
		await secondIdb.whenDisposed;
		await secondIdb.clearLocal();
	});

	test('clearLocal clears the IndexedDB database', async () => {
		const userId = `user-${crypto.randomUUID()}`;

		const firstDoc = new Y.Doc({ guid: 'plaintext-idb-clear', gc: true });
		const firstIdb = attachLocalStorage(firstDoc, {
			server: SERVER,
			ownerId: asOwnerId(userId),
		});
		await firstIdb.whenLoaded;
		firstDoc.getText('body').insert(0, 'clear me');
		await tick();
		firstDoc.destroy();
		await firstIdb.whenDisposed;
		await firstIdb.clearLocal();

		const secondDoc = new Y.Doc({ guid: 'plaintext-idb-clear', gc: true });
		const secondIdb = attachLocalStorage(secondDoc, {
			server: SERVER,
			ownerId: asOwnerId(userId),
		});
		await secondIdb.whenLoaded;

		expect(secondDoc.getText('body').toString()).toBe('');
		secondDoc.destroy();
		await secondIdb.whenDisposed;
		await secondIdb.clearLocal();
	});
});

const originalBroadcastChannel = globalThis.BroadcastChannel;

class FakeBroadcastChannel {
	static names: string[] = [];
	onmessage: ((event: MessageEvent) => void) | null = null;

	constructor(public name: string) {
		FakeBroadcastChannel.names.push(name);
	}

	postMessage(_message: unknown): void {}
	close(): void {}
}

describe('attachLocalStorage BroadcastChannel naming', () => {
	beforeEach(() => {
		FakeBroadcastChannel.names = [];
		Object.assign(globalThis, {
			BroadcastChannel:
				FakeBroadcastChannel as unknown as typeof BroadcastChannel,
		});
	});

	afterEach(() => {
		Object.assign(globalThis, { BroadcastChannel: originalBroadcastChannel });
	});

	test('uses an owner-scoped channel key without changing ydoc.guid', () => {
		const ydoc = new Y.Doc({ guid: 'epicenter-fuji' });

		attachLocalStorage(ydoc, {
			server: SERVER,
			ownerId: asOwnerId('user-123'),
		});

		// y-indexeddb compatibility: attachBroadcastChannel prepends `yjs.` so
		// channels coordinate with the same name y-indexeddb writes for the
		// shared database. The owner-scoped portion is everything after.
		expect(FakeBroadcastChannel.names).toEqual([
			`yjs.epicenter/${SERVER}/owners/user-123/epicenter-fuji`,
		]);
		expect(ydoc.guid).toBe('epicenter-fuji');
		ydoc.destroy();
	});
});

describe('wipeLocalStorage', () => {
	afterEach(async () => {
		await Promise.all(
			(await databaseNames()).map((name) => deleteDatabase(name)),
		);
	});

	test('clears every database under the (server, ownerId) prefix', async () => {
		await createDatabase(`epicenter/${SERVER}/owners/user-1/doc-a`);
		await createDatabase(`epicenter/${SERVER}/owners/user-1/doc-b`);

		await wipeLocalStorage({
			server: SERVER,
			ownerId: asOwnerId('user-1'),
		});

		const remaining = await databaseNames();
		expect(remaining).not.toContain(`epicenter/${SERVER}/owners/user-1/doc-a`);
		expect(remaining).not.toContain(`epicenter/${SERVER}/owners/user-1/doc-b`);
	});

	test('leaves other owners and unscoped databases alone', async () => {
		await createDatabase(`epicenter/${SERVER}/owners/user-1/doc-a`);
		await createDatabase(`epicenter/${SERVER}/owners/user-2/doc-c`);
		await createDatabase('unscoped-doc');

		await wipeLocalStorage({
			server: SERVER,
			ownerId: asOwnerId('user-1'),
		});

		const remaining = await databaseNames();
		expect(remaining).not.toContain(`epicenter/${SERVER}/owners/user-1/doc-a`);
		expect(remaining).toContain(`epicenter/${SERVER}/owners/user-2/doc-c`);
		expect(remaining).toContain('unscoped-doc');
	});
});
