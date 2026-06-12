/**
 * Extension-local chat history.
 *
 * Message bodies persist through TanStack AI's `ChatClientPersistence` into
 * plain IndexedDB, keyed by conversation id (the `createChat` id). They
 * deliberately do NOT live in the workspace Y.Doc: transcripts are
 * single-writer, append-mostly, device-scoped logs, and a future local-model
 * path means a turn may never touch the server, so CRDT storage would pay
 * tombstone and sync costs for no conflict-resolution benefit. The synced
 * `conversations` table keeps only metadata (title, provider, model,
 * timestamps).
 *
 * One database, one out-of-line-keyed store: conversationId -> UIMessage[].
 * UIMessage is structured-clone friendly (Date survives the round trip), so
 * messages store and load verbatim with no serialization layer. Parts
 * persisted by a newer build than the reader render through the
 * unknown-part fallback in MessageParts.svelte.
 *
 * The chat client hydrates through `getItem` and writes the full message
 * list through `setItem` on every change; per-chunk full-list writes are
 * fine in IndexedDB. The client swallows adapter errors by design, so
 * failures are logged here before degrading to an empty history.
 */

import type { ChatClientPersistence, UIMessage } from '@tanstack/ai-client';

const DB_NAME = 'tab-manager-chat';
const STORE_NAME = 'conversations';

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

let dbPromise: Promise<IDBDatabase> | undefined;

function store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
	dbPromise ??= (() => {
		const request = indexedDB.open(DB_NAME, 1);
		request.onupgradeneeded = () => {
			request.result.createObjectStore(STORE_NAME);
		};
		return requestToPromise(request);
	})();
	return dbPromise.then((db) =>
		db.transaction(STORE_NAME, mode).objectStore(STORE_NAME),
	);
}

export const chatPersistence = {
	async getItem(id) {
		try {
			const messages = await requestToPromise<UIMessage[] | undefined>(
				(await store('readonly')).get(id),
			);
			return messages ?? null;
		} catch (error) {
			console.error('[ai-chat] failed to load chat history:', error);
			return null;
		}
	},
	async setItem(id, messages) {
		try {
			await requestToPromise((await store('readwrite')).put(messages, id));
		} catch (error) {
			console.error('[ai-chat] failed to save chat history:', error);
		}
	},
	async removeItem(id) {
		try {
			await requestToPromise((await store('readwrite')).delete(id));
		} catch (error) {
			console.error('[ai-chat] failed to delete chat history:', error);
		}
	},
} satisfies ChatClientPersistence;
