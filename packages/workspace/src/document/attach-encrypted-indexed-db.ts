/// <reference lib="dom" />

import {
	decryptBytes,
	type EncryptedBlob,
	encryptBytes,
} from '@epicenter/encryption';
import * as idb from 'lib0/indexeddb';
import { clearDocument } from 'y-indexeddb';
import type * as Y from 'yjs';
import { applyUpdateV2, encodeStateAsUpdateV2, transact } from 'yjs';
import type { IndexedDbAttachment } from './attach-indexed-db.js';

const UPDATES_STORE_NAME = 'updates';
const CUSTOM_STORE_NAME = 'custom';
const PREFERRED_TRIM_SIZE = 500;
const textEncoder = new TextEncoder();

type EncryptedIndexedDbOptions = {
	databaseName: string;
	writeKey: { version: number; bytes: Uint8Array };
	keyring: ReadonlyMap<number, Uint8Array>;
};

export function attachEncryptedIndexedDb(
	ydoc: Y.Doc,
	{ databaseName, writeKey, keyring }: EncryptedIndexedDbOptions,
): IndexedDbAttachment {
	let db: IDBDatabase | undefined;
	let dbref = 0;
	let dbsize = 0;
	let storeTimeoutId: ReturnType<typeof setTimeout> | undefined;

	const aad = textEncoder.encode(`yjs-update-v2:${ydoc.guid}`);
	const {
		promise: whenLoaded,
		resolve: resolveLoaded,
		reject: rejectLoaded,
	} = Promise.withResolvers<void>();
	// Swallow rejection when no consumer awaits (dispose lands before load,
	// or after the consumer already resolved their wait).
	whenLoaded.catch(() => {});
	const { promise: whenDisposed, resolve: resolveDisposed } =
		Promise.withResolvers<void>();

	const dbPromise = idb.openDB(databaseName, (database) => {
		idb.createStores(database, [
			[UPDATES_STORE_NAME, { autoIncrement: true }],
			[CUSTOM_STORE_NAME],
		]);
	});

	const attachment: IndexedDbAttachment = {
		whenLoaded,
		clearLocal: () => clearDocument(databaseName),
		whenDisposed,
	};

	async function addEncryptedUpdate(
		updatesStore: IDBObjectStore,
		update: Uint8Array,
	): Promise<void> {
		dbsize += 1;
		const ciphertext = encryptBytes({
			key: writeKey.bytes,
			keyVersion: writeKey.version,
			plaintext: update,
			aad,
		});
		await idb.addAutoKey(updatesStore, ciphertext as unknown as string);
	}

	async function fetchUpdates(
		beforeApplyUpdates: (
			updatesStore: IDBObjectStore,
		) => void | Promise<void> = () => {},
		afterApplyUpdates: (
			updatesStore: IDBObjectStore,
		) => void | Promise<void> = () => {},
	): Promise<IDBObjectStore> {
		if (db === undefined) {
			throw new Error(
				'Cannot fetch encrypted IndexedDB updates before DB open.',
			);
		}
		const [updatesStore] = idb.transact(db, [UPDATES_STORE_NAME]);
		if (updatesStore === undefined) {
			throw new Error('Encrypted IndexedDB updates store is missing.');
		}
		const encryptedUpdates = (await idb.getAll(
			updatesStore,
			IDBKeyRange.lowerBound(dbref, false),
		)) as EncryptedBlob[];
		if (!ydoc.isDestroyed) {
			await beforeApplyUpdates(updatesStore);
			transact(
				ydoc,
				() => {
					for (const blob of encryptedUpdates) {
						applyUpdateV2(
							ydoc,
							decryptBytes({ keyring, blob, aad }),
							attachment,
						);
					}
				},
				attachment,
				false,
			);
			await afterApplyUpdates(updatesStore);
		}
		const lastKey = (await idb.getLastKey(updatesStore)) as number | null;
		dbref = lastKey === null ? 0 : lastKey + 1;
		dbsize = await idb.count(updatesStore);
		return updatesStore;
	}

	// Debounced compaction: merge any pending updates, then if the running count
	// is still over the trim threshold, encrypt a snapshot and drop the older
	// per-update rows. The threshold check inside survives a concurrent
	// cross-tab compaction lowering `dbsize` between schedule and fire.
	async function compactUpdates(): Promise<void> {
		const updatesStore = await fetchUpdates();
		if (dbsize < PREFERRED_TRIM_SIZE) return;
		await addEncryptedUpdate(updatesStore, encodeStateAsUpdateV2(ydoc));
		await idb.del(updatesStore, IDBKeyRange.upperBound(dbref, true));
		dbsize = await idb.count(updatesStore);
	}

	const handleUpdate = (update: Uint8Array, origin: unknown) => {
		if (db === undefined || origin === attachment) return;
		const [updatesStore] = idb.transact(db, [UPDATES_STORE_NAME]);
		if (updatesStore === undefined) return;
		void addEncryptedUpdate(updatesStore, update);
		if (dbsize >= PREFERRED_TRIM_SIZE) {
			if (storeTimeoutId !== undefined) clearTimeout(storeTimeoutId);
			storeTimeoutId = setTimeout(() => {
				void compactUpdates();
				storeTimeoutId = undefined;
			}, 1000);
		}
	};

	dbPromise
		.then(async (openedDb) => {
			db = openedDb;
			await fetchUpdates(
				(updatesStore) =>
					addEncryptedUpdate(updatesStore, encodeStateAsUpdateV2(ydoc)),
				() => {
					if (!ydoc.isDestroyed) resolveLoaded();
				},
			);
		})
		.catch((error: unknown) => {
			rejectLoaded(error);
		});

	ydoc.on('updateV2', handleUpdate);
	ydoc.once('destroy', async () => {
		if (storeTimeoutId !== undefined) clearTimeout(storeTimeoutId);
		ydoc.off('updateV2', handleUpdate);
		// Settle the load barrier if destroy lands before the boot chain
		// resolves it. No-op when `whenLoaded` is already settled.
		rejectLoaded(
			new Error(
				'[attachEncryptedIndexedDb] doc destroyed before load completed',
			),
		);
		try {
			(await dbPromise).close();
		} finally {
			resolveDisposed();
		}
	});

	return attachment;
}
