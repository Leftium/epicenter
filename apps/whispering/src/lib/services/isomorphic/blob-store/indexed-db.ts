import { openDB } from 'idb';
import type { BlobStore } from './types.js';

interface BlobRecord {
	id: string;
	arrayBuffer: ArrayBuffer;
	mimeType: string;
}

/**
 * IndexedDB-backed blob store.
 *
 * Stores audio as ArrayBuffer (not Blob) to avoid Safari's well-documented
 * issues with Blob storage in IndexedDB — including silent data loss,
 * Private Browsing failures, and periodic erasure.
 *
 * @see https://bugs.webkit.org/show_bug.cgi?id=188438
 */
export function createIndexedDbBlobStore({
	dbName,
	storeName,
}: {
	dbName: string;
	storeName: string;
}): BlobStore {
	const dbPromise = openDB(dbName, 1, {
		upgrade(db) {
			if (!db.objectStoreNames.contains(storeName)) {
				db.createObjectStore(storeName, { keyPath: 'id' });
			}
		},
	});

	return {
		async get(id) {
			const db = await dbPromise;
			const record: BlobRecord | undefined = await db.get(storeName, id);
			if (!record) return null;

			const blob = new Blob([record.arrayBuffer], { type: record.mimeType });
			return { blob, mimeType: record.mimeType };
		},

		async put(id, blob, mimeType) {
			const db = await dbPromise;
			const arrayBuffer = await blob.arrayBuffer();
			await db.put(storeName, { id, arrayBuffer, mimeType } satisfies BlobRecord);
		},

		async delete(id) {
			const db = await dbPromise;
			await db.delete(storeName, id);
		},

		async has(id) {
			const db = await dbPromise;
			const count = await db.count(storeName, id);
			return count > 0;
		},
	};
}
