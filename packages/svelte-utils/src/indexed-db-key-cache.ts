import type { UserKeyCache } from '@epicenter/workspace';

const DB_NAME = 'epicenter-key-cache';
const STORE_NAME = 'keys';

/**
 * Open (or create) the shared IndexedDB database for key caching.
 *
 * The database has a single object store with no key path—entries are
 * keyed by the caller-provided `storageKey` string. Each app gets its
 * own key so multiple apps on the same origin don't collide.
 */
function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, 1);
		request.onupgradeneeded = () => {
			request.result.createObjectStore(STORE_NAME);
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

/**
 * Run a single read or write transaction against the key cache store.
 *
 * Wraps the IndexedDB transaction lifecycle in a promise so callers
 * don't need to juggle `onsuccess`/`onerror`/`oncomplete` callbacks.
 */
function withTransaction<T>(
	mode: IDBTransactionMode,
	fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
	return openDb().then(
		(db) =>
			new Promise((resolve, reject) => {
				const tx = db.transaction(STORE_NAME, mode);
				const request = fn(tx.objectStore(STORE_NAME));
				request.onsuccess = () => resolve(request.result);
				tx.onerror = () => reject(tx.error);
			}),
	);
}

/**
 * Create a `UserKeyCache` backed by IndexedDB.
 *
 * Survives tab closes, page refreshes, and browser restarts—unlike
 * `sessionStorage` which clears when the tab closes. The key persists
 * until explicitly cleared (usually on sign-out).
 *
 * Uses raw IndexedDB (no `idb` library) since the cache only needs
 * three operations on a single key.
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
			await withTransaction('readwrite', (store) =>
				store.put(userKeyBase64, storageKey),
			);
		},
		async load() {
			const value = await withTransaction('readonly', (store) =>
				store.get(storageKey),
			);
			return typeof value === 'string' ? value : null;
		},
		async clear() {
			await withTransaction('readwrite', (store) =>
				store.delete(storageKey),
			);
		},
	};
}
