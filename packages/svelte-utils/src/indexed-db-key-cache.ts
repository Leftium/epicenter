import type { UserKeyCache } from '@epicenter/workspace';
import { openDB, type DBSchema } from 'idb';

const DB_NAME = 'epicenter-key-cache';
const STORE_NAME = 'keys' as const;

type KeyCacheDB = DBSchema & {
	[K in typeof STORE_NAME]: {
		key: string;
		value: string;
	};
};

/**
 * Lazily open (or create) the shared IndexedDB database for key caching.
 *
 * The database has a single object store with no key path—entries are
 * keyed by the caller-provided `storageKey` string. Each app gets its
 * own key so multiple apps on the same origin don't collide.
 */
const dbPromise = openDB<KeyCacheDB>(DB_NAME, 1, {
	upgrade(db) {
		db.createObjectStore(STORE_NAME);
	},
});

/**
 * Create a `UserKeyCache` backed by IndexedDB.
 *
 * Survives tab closes, page refreshes, and browser restarts—unlike
 * `sessionStorage` which clears when the tab closes. The key persists
 * until explicitly cleared (usually on sign-out).
 *
 * @param storageKey - Unique key within the shared store, typically
 *   `'{appName}:encryption-key'` to avoid collisions across apps on
 *   the same origin.
 *
 * @example
 * ```typescript
 * import { createIndexedDbKeyCache } from '@epicenter/svelte-utils';
 *
 * export const userKeyCache = createIndexedDbKeyCache('honeycrisp:encryption-key');
 * ```
 */
export function createIndexedDbKeyCache(storageKey: string): UserKeyCache {
	return {
		async save(userKeyBase64) {
			const db = await dbPromise;
			await db.put(STORE_NAME, userKeyBase64, storageKey);
		},
		async load() {
			const db = await dbPromise;
			return (await db.get(STORE_NAME, storageKey)) ?? null;
		},
		async clear() {
			const db = await dbPromise;
			await db.delete(STORE_NAME, storageKey);
		},
	};
}
