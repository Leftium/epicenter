import type { BlobStore } from './types.js';

function openDb(dbName: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(dbName, 1);

		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains('blobs')) {
				db.createObjectStore('blobs', { keyPath: 'id' });
			}
		};

		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

export function createIndexedDbBlobStore(dbName: string): BlobStore {
	let dbPromise: Promise<IDBDatabase> | null = null;

	function getDb(): Promise<IDBDatabase> {
		if (!dbPromise) {
			dbPromise = openDb(dbName);
		}
		return dbPromise;
	}

	async function transaction<T>(
		mode: IDBTransactionMode,
		fn: (store: IDBObjectStore) => IDBRequest<T>,
	): Promise<T> {
		const db = await getDb();
		return new Promise<T>((resolve, reject) => {
			const tx = db.transaction('blobs', mode);
			const store = tx.objectStore('blobs');
			const request = fn(store);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
	}

	return {
		async get(id) {
			const record = await transaction('readonly', (store) =>
				store.get(id),
			);
			if (!record) return null;

			const { arrayBuffer, blobType } = record as {
				arrayBuffer: ArrayBuffer;
				blobType: string;
			};
			const blob = new Blob([arrayBuffer], { type: blobType });
			return { blob, mimeType: blobType };
		},

		async put(id, blob, mimeType) {
			const arrayBuffer = await blob.arrayBuffer();
			await transaction('readwrite', (store) =>
				store.put({ id, arrayBuffer, blobType: mimeType }),
			);
		},

		async delete(id) {
			await transaction('readwrite', (store) => store.delete(id));
		},

		async has(id) {
			const record = await transaction('readonly', (store) =>
				store.get(id),
			);
			return record != null;
		},
	};
}
