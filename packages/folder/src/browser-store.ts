/**
 * The IndexedDB format earlier versions kept a browser folder in, read only
 * to copy it into the origin private file system (`browser-migration.ts`).
 *
 * One database per folder holds the portable files (`inventory` and
 * `contents`, keyed by literal path), directories the shell created
 * (`directories`), and private Git state (`git`, keyed by `/git/...`). Nothing
 * here writes those four stores: after the copy they stay as the backup.
 */

/** The IndexedDB a browser folder's earlier database is found in. */
export type IndexedDbEnvironment = {
	readonly indexedDB: IDBFactory;
	readonly IDBKeyRange: typeof IDBKeyRange;
};

/** Metadata earlier versions kept beside each file's bytes. */
export type InventoryRecord = {
	readonly sha256: string;
	readonly size: number;
	readonly mtimeMs: number;
	readonly ino: number;
};

/** The four stores of an earlier version's folder database. */
export const STORES = {
	inventory: 'inventory',
	contents: 'contents',
	directories: 'directories',
	git: 'git',
} as const;

export function request<T>(value: IDBRequest<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		value.onsuccess = () => resolve(value.result);
		value.onerror = () => reject(value.error);
	});
}

/** Resolves once `tx` committed: its writes are durable. */
export function completion(tx: IDBTransaction): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onabort = () =>
			reject(tx.error ?? new Error('The storage transaction aborted'));
		tx.onerror = () => reject(tx.error);
	});
}
