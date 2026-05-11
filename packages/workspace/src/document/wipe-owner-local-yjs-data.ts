/// <reference lib="dom" />

import { clearDocument } from 'y-indexeddb';
import { createOwnedYjsKey, createOwnedYjsKeyPrefix } from './local-yjs-key.js';

type IndexedDbDatabaseInfo = {
	name?: string | null;
};

type IndexedDbFactoryWithDatabases = IDBFactory & {
	databases?: () => Promise<IndexedDbDatabaseInfo[]>;
};

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
