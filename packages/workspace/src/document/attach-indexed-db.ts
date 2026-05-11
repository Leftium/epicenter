/// <reference lib="dom" />

import {
	decryptBytes,
	type EncryptedBlob,
	encryptBytes,
} from '@epicenter/encryption';
import * as idb from 'lib0/indexeddb';
import { clearDocument, IndexeddbPersistence } from 'y-indexeddb';
import type * as Y from 'yjs';
import { applyUpdateV2, encodeStateAsUpdateV2, transact } from 'yjs';
import { createOwnedYjsKey, createOwnedYjsKeyPrefix } from './local-yjs-key.js';

const UPDATES_STORE_NAME = 'updates';
const CUSTOM_STORE_NAME = 'custom';
const PREFERRED_TRIM_SIZE = 500;
const textEncoder = new TextEncoder();

export type IndexedDbAttachment = {
	/**
	 * Resolves when local IndexedDB state has loaded into the Y.Doc: "your
	 * draft is in memory, edits are safe." Not CRDT convergence despite
	 * `y-indexeddb`'s upstream `whenSynced` name. Pair with `sync.whenConnected`
	 * when you also need remote state.
	 */
	whenLoaded: Promise<unknown>;
	clearLocal: () => Promise<void>;
	/**
	 * Resolves after `ydoc.destroy()` fires the cascade and the IndexedDB
	 * connection has actually closed. Bundle wipe methods await this before
	 * deleting persisted data.
	 */
	whenDisposed: Promise<unknown>;
};

type EncryptedIndexedDbOptions = {
	databaseName: string;
	keyring: ReadonlyMap<number, Uint8Array>;
};

type IndexedDbDatabaseInfo = {
	name?: string | null;
};

type IndexedDbFactoryWithDatabases = IDBFactory & {
	databases?: () => Promise<IndexedDbDatabaseInfo[]>;
};

export function attachIndexedDb(ydoc: Y.Doc): IndexedDbAttachment {
	const databaseName = ydoc.guid;
	const idb = new IndexeddbPersistence(databaseName, ydoc);
	// `IndexeddbPersistence`'s constructor binds `doc.on('destroy', this.destroy)`
	// eagerly, and its `destroy()` has no top-level idempotency guard: two calls
	// produce two independent `_db.then(db => db.close())` promises that resolve
	// at different moments. Strip the upstream binding so our wrapper is the
	// sole gateway. Cascade-triggered teardown resolves `whenDisposed` only
	// after the actual close completes, so wipe() can await an honest barrier.
	ydoc.off('destroy', idb.destroy);
	const { promise: whenDisposed, resolve: resolveDisposed } =
		Promise.withResolvers<void>();
	ydoc.once('destroy', async () => {
		try {
			await idb.destroy();
		} finally {
			resolveDisposed();
		}
	});
	return {
		whenLoaded: idb.whenSynced,
		clearLocal: () => clearDocument(databaseName),
		whenDisposed,
	};
}

export async function wipeOwnerLocalYjsData({
	userId,
	ydocGuids = [],
}: {
	userId: string;
	ydocGuids?: Iterable<string>;
}): Promise<void> {
	const indexedDB = globalThis.indexedDB as
		| IndexedDbFactoryWithDatabases
		| undefined;
	const prefix = createOwnedYjsKeyPrefix(userId);
	const names = new Set<string>();

	for (const guid of ydocGuids) {
		names.add(createOwnedYjsKey(userId, guid));
	}

	if (indexedDB?.databases) {
		const databases = await indexedDB.databases().catch(() => []);
		for (const database of databases) {
			if (typeof database.name !== 'string') continue;
			if (!database.name.startsWith(prefix)) continue;
			names.add(database.name);
		}
	}

	await Promise.all([...names].map((name) => clearDocument(name)));
}

function resolveWriteKey(keyring: ReadonlyMap<number, Uint8Array>): {
	keyVersion: number;
	key: Uint8Array;
} {
	if (keyring.size === 0) {
		throw new Error(
			'Cannot attach encrypted IndexedDB provider: keyring is empty.',
		);
	}
	const keyVersion = Math.max(...keyring.keys());
	const key = keyring.get(keyVersion);
	if (key === undefined) {
		throw new Error(
			`Cannot attach encrypted IndexedDB provider: key version ${keyVersion} is not in the keyring.`,
		);
	}
	return { keyVersion, key };
}

export function attachEncryptedIndexedDb(
	ydoc: Y.Doc,
	{ databaseName, keyring }: EncryptedIndexedDbOptions,
): IndexedDbAttachment {
	// Keyring is frozen at attach time, so resolve the write key once at the
	// boundary. An empty or malformed keyring fails fast here instead of
	// surfacing on the first write.
	const { keyVersion: writeVersion, key: writeKey } = resolveWriteKey(keyring);

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
			key: writeKey,
			keyVersion: writeVersion,
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
