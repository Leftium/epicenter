import { clearDocument } from 'y-indexeddb';
import { createLocalYjsKey } from './local-yjs-key.js';

type IndexedDbDatabaseInfo = {
	name?: string | null;
};

type IndexedDbFactoryWithDatabases = IDBFactory & {
	databases?: () => Promise<IndexedDbDatabaseInfo[]>;
};

export type ClearLocalYjsDataForUserOptions = {
	userId: string;
	ydocGuids?: Iterable<string>;
	indexedDB?: IndexedDbFactoryWithDatabases;
	clearDocument?: (name: string) => Promise<void>;
};

export async function clearLocalYjsDataForUser({
	userId,
	ydocGuids = [],
	indexedDB = globalThis.indexedDB as IndexedDbFactoryWithDatabases | undefined,
	clearDocument: clear = clearDocument,
}: ClearLocalYjsDataForUserOptions): Promise<void> {
	const prefix = `epicenter:v1:user:${userId}:yjs:`;
	const names = new Set<string>();

	for (const guid of ydocGuids) {
		names.add(createLocalYjsKey(userId, guid));
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
