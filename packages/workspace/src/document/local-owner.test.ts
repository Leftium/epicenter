/**
 * LocalOwner behavior tests.
 *
 * Covers the three identity-scoped surfaces exposed by `createLocalOwner`:
 * - `attachIndexedDb`: encrypted persistence keyed by `(userId, ydoc.guid)`,
 *   including the round-trip and guid-bound storage key invariants moved
 *   here from `attach-encryption.test.ts`.
 * - `attachBroadcastChannel`: owner-scoped channel key without mutating
 *   `ydoc.guid`.
 * - `wipeLocalYjsData`: deletes known guids and enumerated owner-scoped
 *   databases, leaves other owners and unscoped local docs alone.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	base64ToBytes,
	bytesToBase64,
	decryptBytes,
	deriveWorkspaceKey,
	type EncryptedBlob,
	type EncryptionKeys,
} from '@epicenter/encryption';
import { randomBytes } from '@noble/ciphers/utils.js';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import * as Y from 'yjs';
import { createLocalOwner } from './local-owner.js';

Object.assign(globalThis, { indexedDB, IDBKeyRange });

function toEncryptionKeys(key: Uint8Array): EncryptionKeys {
	return [{ version: 1, userKeyBase64: bytesToBase64(key) }];
}

const noKeys: () => EncryptionKeys = () => toEncryptionKeys(randomBytes(32));

function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

async function readEncryptedUpdates(dbName: string): Promise<EncryptedBlob[]> {
	const db = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(dbName);
		request.onerror = () => reject(request.error);
		request.onsuccess = () => resolve(request.result);
	});
	try {
		const transaction = db.transaction(['updates'], 'readonly');
		const store = transaction.objectStore('updates');
		return await new Promise<EncryptedBlob[]>((resolve, reject) => {
			const request = store.getAll();
			request.onerror = () => reject(request.error);
			request.onsuccess = () => resolve(request.result as EncryptedBlob[]);
		});
	} finally {
		db.close();
	}
}

function keyringForGuid(
	keys: EncryptionKeys,
	guid: string,
): Map<number, Uint8Array> {
	return new Map(
		keys.map(({ version, userKeyBase64 }) => [
			version,
			deriveWorkspaceKey(base64ToBytes(userKeyBase64), guid),
		]),
	);
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

describe('LocalOwner.attachIndexedDb', () => {
	test('throws when encryptionKeys throws', () => {
		const ydoc = new Y.Doc({ guid: 'encrypted-idb-no-keys', gc: false });
		const owner = createLocalOwner({
			userId: 'user-no-keys',
			encryptionKeys: () => {
				throw new Error('not signed-in');
			},
		});

		expect(() => owner.attachIndexedDb(ydoc)).toThrow('not signed-in');
		ydoc.destroy();
	});

	test('round trips encrypted Yjs updates through IndexedDB', async () => {
		const userId = `user-${crypto.randomUUID()}`;
		const databaseName = `epicenter.v1.user.${userId}.yjs.encrypted-idb-roundtrip`;
		const keys = toEncryptionKeys(randomBytes(32));

		const firstDoc = new Y.Doc({
			guid: 'encrypted-idb-roundtrip',
			gc: false,
		});
		const firstOwner = createLocalOwner({ userId, encryptionKeys: () => keys });
		const firstIdb = firstOwner.attachIndexedDb(firstDoc);
		await firstIdb.whenLoaded;
		firstDoc.getText('body').insert(0, 'stored ciphertext');
		await tick();
		firstDoc.destroy();
		await firstIdb.whenDisposed;

		const rawUpdates = await readEncryptedUpdates(databaseName);
		expect(rawUpdates.length).toBeGreaterThan(0);
		expect(rawUpdates.every((update) => update[0] === 1)).toBe(true);

		const secondDoc = new Y.Doc({
			guid: 'encrypted-idb-roundtrip',
			gc: false,
		});
		const secondOwner = createLocalOwner({
			userId,
			encryptionKeys: () => keys,
		});
		const secondIdb = secondOwner.attachIndexedDb(secondDoc);
		await secondIdb.whenLoaded;

		expect(secondDoc.getText('body').toString()).toBe('stored ciphertext');
		secondDoc.destroy();
		await secondIdb.whenDisposed;
		await secondIdb.clearLocal();
	});

	test('target guid changes the derived storage key', async () => {
		const userId = `user-${crypto.randomUUID()}`;
		const databaseName = `epicenter.v1.user.${userId}.yjs.encrypted-idb-guid-a`;
		const keys = toEncryptionKeys(randomBytes(32));
		const ydoc = new Y.Doc({ guid: 'encrypted-idb-guid-a', gc: false });
		const owner = createLocalOwner({ userId, encryptionKeys: () => keys });
		const idb = owner.attachIndexedDb(ydoc);
		await idb.whenLoaded;
		ydoc.getText('body').insert(0, 'guid bound');
		await tick();
		ydoc.destroy();
		await idb.whenDisposed;

		const rawUpdates = await readEncryptedUpdates(databaseName);
		const updateWithContent = rawUpdates.at(-1);
		expect(updateWithContent).toBeDefined();
		expect(() =>
			decryptBytes({
				keyring: keyringForGuid(keys, 'encrypted-idb-guid-b'),
				blob: updateWithContent as EncryptedBlob,
				aad: new TextEncoder().encode('yjs-update-v2:encrypted-idb-guid-a'),
			}),
		).toThrow();
		await idb.clearLocal();
	});

	test('clearLocal clears the encrypted IndexedDB database', async () => {
		const userId = `user-${crypto.randomUUID()}`;
		const keys = toEncryptionKeys(randomBytes(32));

		const firstDoc = new Y.Doc({ guid: 'encrypted-idb-clear', gc: false });
		const firstOwner = createLocalOwner({ userId, encryptionKeys: () => keys });
		const firstIdb = firstOwner.attachIndexedDb(firstDoc);
		await firstIdb.whenLoaded;
		firstDoc.getText('body').insert(0, 'clear me');
		await tick();
		firstDoc.destroy();
		await firstIdb.whenDisposed;
		await firstIdb.clearLocal();

		const secondDoc = new Y.Doc({ guid: 'encrypted-idb-clear', gc: false });
		const secondOwner = createLocalOwner({
			userId,
			encryptionKeys: () => keys,
		});
		const secondIdb = secondOwner.attachIndexedDb(secondDoc);
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

describe('LocalOwner.attachBroadcastChannel', () => {
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
		const ydoc = new Y.Doc({ guid: 'epicenter.fuji' });
		const owner = createLocalOwner({
			userId: 'user-123',
			encryptionKeys: noKeys,
		});

		owner.attachBroadcastChannel(ydoc);

		expect(FakeBroadcastChannel.names).toEqual([
			'yjs.epicenter.v1.user.user-123.yjs.epicenter.fuji',
		]);
		expect(ydoc.guid).toBe('epicenter.fuji');
		ydoc.destroy();
	});
});

describe('LocalOwner.wipeLocalYjsData', () => {
	afterEach(async () => {
		await Promise.all(
			(await databaseNames()).map((name) => deleteDatabase(name)),
		);
	});

	test('clears known scoped document keys', async () => {
		await createDatabase('epicenter.v1.user.user-1.yjs.doc-a');
		await createDatabase('epicenter.v1.user.user-1.yjs.doc-b');

		const owner = createLocalOwner({
			userId: 'user-1',
			encryptionKeys: noKeys,
		});
		await owner.wipeLocalYjsData(['doc-a', 'doc-b']);

		const remaining = await databaseNames();
		expect(remaining).not.toContain('epicenter.v1.user.user-1.yjs.doc-a');
		expect(remaining).not.toContain('epicenter.v1.user.user-1.yjs.doc-b');
	});

	test('also clears enumerated scoped database names and leaves others alone', async () => {
		await createDatabase('epicenter.v1.user.user-1.yjs.doc-a');
		await createDatabase('epicenter.v1.user.user-1.yjs.doc-b');
		await createDatabase('epicenter.v1.user.user-2.yjs.doc-c');
		await createDatabase('unscoped-doc');

		const owner = createLocalOwner({
			userId: 'user-1',
			encryptionKeys: noKeys,
		});
		await owner.wipeLocalYjsData(['doc-a']);

		const remaining = await databaseNames();
		expect(remaining).not.toContain('epicenter.v1.user.user-1.yjs.doc-a');
		expect(remaining).not.toContain('epicenter.v1.user.user-1.yjs.doc-b');
		expect(remaining).toContain('epicenter.v1.user.user-2.yjs.doc-c');
		expect(remaining).toContain('unscoped-doc');
	});
});
