/**
 * Regression gate for `patches/y-indexeddb@9.0.12.patch`.
 *
 * Before the patch, a single corrupt update persisted in IndexedDB broke the
 * y-indexeddb load path in two user-visible ways at once:
 *
 *   1. `whenLoaded` NEVER resolved. y-indexeddb applies stored updates inside
 *      the `getAll().then(...)` callback and only emits `'synced'` AFTER the
 *      apply loop. A throw in the loop skipped the emit, so `whenSynced` (which
 *      `attachIndexedDb` exposes as `whenLoaded`) was wedged forever and the app
 *      hung on boot waiting for its draft to load.
 *
 *   2. The decode error floated as an UNHANDLED rejection. `fetchUpdates`'
 *      promise is discarded in the IndexeddbPersistence constructor and the
 *      `_db.then(...)` has no `.catch`, so the throw surfaced as
 *      `Uncaught (in promise) Error: Unexpected end of array` with lib0's
 *      useless singleton stack.
 *
 * The patch wraps the per-update `Y.applyUpdate` in a `try/catch` that skips the
 * bad bytes (server resync supplies them) and lets `'synced'` still fire. This
 * test asserts that healed behavior: `whenLoaded` resolves and no rejection
 * floats. It goes RED the day the patch stops applying (an unverified
 * y-indexeddb bump), which is the whole reason to keep it.
 */

import { expect, test } from 'bun:test';
import { asOwnerId } from '@epicenter/identity';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import * as Y from 'yjs';
import { attachLocalStorage } from './attach-local-storage.js';
import { wipeLocalStorage } from './wipe-local-storage.js';

Object.assign(globalThis, { indexedDB, IDBKeyRange });

const SERVER = 'api.epicenter.so';

function tick(ms = 0): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Overwrite every stored update with an unterminated varuint (`0x80`). The
 * high bit signals "another byte follows," but the buffer ends, so the first
 * `readVarUint` in `Y.applyUpdate` overruns: the exact `Unexpected end of
 * array` a half-written update produces.
 */
async function corruptStoredUpdates(databaseName: string): Promise<void> {
	const db = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(databaseName);
		request.onerror = () => reject(request.error);
		request.onsuccess = () => resolve(request.result);
	});
	try {
		const transaction = db.transaction(['updates'], 'readwrite');
		const store = transaction.objectStore('updates');
		await new Promise<void>((resolve, reject) => {
			const request = store.openCursor();
			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				const cursor = request.result;
				if (!cursor) {
					resolve();
					return;
				}
				cursor.update(new Uint8Array([0x80]));
				cursor.continue();
			};
		});
	} finally {
		db.close();
	}
}

// Capture any decode rejection that escapes to the process boundary. Pre-patch
// the load floated an uncatchable one here (the only place it could be seen);
// post-patch this array must stay empty, which is assertion 4b below.
const rejections: unknown[] = [];
process.on('unhandledRejection', (reason) => {
	rejections.push(reason);
});

test('a corrupt persisted update is skipped: whenLoaded resolves and no decode error floats', async () => {
	const userId = `user-${crypto.randomUUID()}`;
	const guid = 'plaintext-idb-corrupt-load';
	const databaseName = `epicenter/${SERVER}/owners/${userId}/${guid}`;

	// 1. Persist a real doc so the store exists with genuine update bytes.
	const firstDoc = new Y.Doc({ guid, gc: true });
	const firstIdb = attachLocalStorage(firstDoc, {
		server: SERVER,
		ownerId: asOwnerId(userId),
	});
	await firstIdb.whenLoaded;
	firstDoc.getText('body').insert(0, 'real content');
	await tick();
	firstDoc.destroy();
	await firstIdb.whenDisposed;

	// 2. Corrupt what is on disk (simulates a half-written / old-format update).
	await corruptStoredUpdates(databaseName);

	// 3. Re-attach a fresh doc, as a cold boot would.
	const secondDoc = new Y.Doc({ guid, gc: true });
	const secondIdb = attachLocalStorage(secondDoc, {
		server: SERVER,
		ownerId: asOwnerId(userId),
	});

	// Healed behavior (the patch skips the bad update and still emits 'synced'):

	// 4a. whenLoaded must RESOLVE, not hang. Pre-patch it lost this race to the
	//     timeout because 'synced' never fired after the apply threw.
	const outcome = await Promise.race([
		secondIdb.whenLoaded.then(() => 'loaded' as const),
		tick(250).then(() => 'hung' as const),
	]);
	expect(outcome).toBe('loaded');

	// 4b. No decode error must float. Pre-patch one did (the uncatchable rejection).
	await tick();
	const floatedDecodeError = rejections.some(
		(reason) =>
			reason instanceof Error &&
			reason.message.includes('Unexpected end of array'),
	);
	expect(floatedDecodeError).toBe(false);

	// Best-effort cleanup; the assertions above are what matter.
	secondDoc.destroy();
	await wipeLocalStorage({ server: SERVER, ownerId: asOwnerId(userId) });
});
