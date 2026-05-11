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

type EncryptedProviderOptions = {
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
	await wipeOwnerLocalYjsDataWithDependencies(
		{ userId, ydocGuids },
		{
			indexedDB: globalThis.indexedDB as
				| IndexedDbFactoryWithDatabases
				| undefined,
			clearDocument,
		},
	);
}

async function wipeOwnerLocalYjsDataWithDependencies(
	{
		userId,
		ydocGuids = [],
	}: {
		userId: string;
		ydocGuids?: Iterable<string>;
	},
	{
		indexedDB,
		clearDocument: clear,
	}: {
		indexedDB?: IndexedDbFactoryWithDatabases;
		clearDocument: (name: string) => Promise<void>;
	},
): Promise<void> {
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

	await Promise.all([...names].map((name) => clear(name)));
}

export function attachEncryptedProvider(
	ydoc: Y.Doc,
	{ databaseName, keyring }: EncryptedProviderOptions,
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

	function currentKey(): { version: number; key: Uint8Array } {
		if (keyring.size === 0) {
			throw new Error(
				'Cannot write encrypted IndexedDB update: keyring is empty.',
			);
		}
		const version = Math.max(...keyring.keys());
		const key = keyring.get(version);
		if (key === undefined) {
			throw new Error(
				`Cannot write encrypted IndexedDB update: key version ${version} is not in the keyring.`,
			);
		}
		return { version, key };
	}

	function encryptUpdate(update: Uint8Array): EncryptedBlob {
		const { version, key } = currentKey();
		return encryptBytes({
			key,
			keyVersion: version,
			plaintext: update,
			aad,
		});
	}

	function decryptUpdate(blob: EncryptedBlob): Uint8Array {
		return decryptBytes({ keyring, blob, aad });
	}

	async function addEncryptedUpdate(
		updatesStore: IDBObjectStore,
		update: Uint8Array,
	): Promise<void> {
		dbsize += 1;
		await idb.addAutoKey(
			updatesStore,
			encryptUpdate(update) as unknown as string,
		);
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
					for (const encryptedUpdate of encryptedUpdates) {
						applyUpdateV2(ydoc, decryptUpdate(encryptedUpdate), attachment);
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

	async function storeState(forceStore = true): Promise<void> {
		const updatesStore = await fetchUpdates();
		if (forceStore || dbsize >= PREFERRED_TRIM_SIZE) {
			await addEncryptedUpdate(updatesStore, encodeStateAsUpdateV2(ydoc));
			await idb.del(updatesStore, IDBKeyRange.upperBound(dbref, true));
			dbsize = await idb.count(updatesStore);
		}
	}

	const handleUpdate = (update: Uint8Array, origin: unknown) => {
		if (db === undefined || origin === attachment) return;
		const [updatesStore] = idb.transact(db, [UPDATES_STORE_NAME]);
		if (updatesStore === undefined) return;
		void addEncryptedUpdate(updatesStore, update);
		if (dbsize >= PREFERRED_TRIM_SIZE) {
			if (storeTimeoutId !== undefined) clearTimeout(storeTimeoutId);
			storeTimeoutId = setTimeout(() => {
				void storeState(false);
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
		try {
			(await dbPromise).close();
		} finally {
			resolveDisposed();
		}
	});

	return attachment;
}
