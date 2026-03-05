import { openDB } from 'idb';
import type { BlobStore } from './types.js';

/**
 * Shape of a blob entry persisted in IndexedDB.
 *
 * Blobs are stored as raw `ArrayBuffer` rather than `Blob` because Safari has
 * well-documented issues with Blob storage in IndexedDB — silent data loss,
 * Private Browsing failures, and periodic erasure. Converting to `ArrayBuffer`
 * on write and back to `Blob` on read sidesteps all of these.
 *
 * The `id` field doubles as the IDB key (`keyPath: 'id'`), so every record
 * is addressable by a simple string lookup.
 *
 * @see https://bugs.webkit.org/show_bug.cgi?id=188438 — Safari IndexedDB Blob bugs
 */
type BlobRecord = {
	id: string;
	arrayBuffer: ArrayBuffer;
	mimeType: string;
};

/**
 * Creates an IndexedDB-backed {@link BlobStore}.
 *
 * Each blob is persisted as a {@link BlobRecord} — an `ArrayBuffer` + MIME
 * type pair keyed by a string ID. See `BlobRecord` for why `ArrayBuffer` is
 * used instead of `Blob`.
 *
 * @see https://bugs.webkit.org/show_bug.cgi?id=188438 — Safari IndexedDB Blob bugs
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
			await db.put(storeName, {
				id,
				arrayBuffer,
				mimeType,
			} satisfies BlobRecord);
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
