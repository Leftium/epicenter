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
 * This module is also the single boundary where persisted parts re-enter the
 * TanStack AI type system, so the compile-time drift check lives here.
 */

import type { ChatClientPersistence, UIMessage } from '@tanstack/ai-client';
import type { TabManagerBrowser } from '$lib/tab-manager/extension';

// ── Compile-time drift detection ──────────────────────────────────────
// Rolling-your-own type testing from Total TypeScript.
// If TanStack AI adds, removes, or renames a part type, TypeScript reports
// a type error here, forcing us to update our understanding.
// @see https://www.totaltypescript.com/how-to-test-your-types#rolling-your-own

type Expect<T extends true> = T;
type Equal<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
		? true
		: false;

type UiMessagePart = UIMessage['parts'][number];

type ExpectedPartTypes =
	| 'text'
	| 'image'
	| 'audio'
	| 'video'
	| 'document'
	| 'tool-call'
	| 'tool-result'
	| 'thinking'
	| 'structured-output';

type _DriftCheck = Expect<Equal<UiMessagePart['type'], ExpectedPartTypes>>;

// ── IndexedDB plumbing ─────────────────────────────────────────────────
// One database, one out-of-line-keyed store: conversationId -> UIMessage[].
// UIMessage is structured-clone friendly (Date survives the round trip), so
// messages store and load verbatim with no serialization layer.

const DB_NAME = 'tab-manager-chat';
const STORE_NAME = 'conversations';

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

function openChatDb(): Promise<IDBDatabase> {
	const request = indexedDB.open(DB_NAME, 1);
	request.onupgradeneeded = () => {
		request.result.createObjectStore(STORE_NAME);
	};
	return requestToPromise(request);
}

/**
 * Create the chat history adapter for `createChat({ persistence })`.
 *
 * The chat client hydrates each conversation through `getItem` and writes
 * the full message list through `setItem` on every change; per-chunk
 * full-list writes are fine in IndexedDB (the old write-amplification
 * refusal applied only to CRDT-backed storage). The client swallows adapter
 * errors by design, so failures are logged here before degrading to an
 * empty history.
 */
export function createChatPersistence({
	tabManager,
}: {
	tabManager: TabManagerBrowser;
}) {
	let dbPromise: Promise<IDBDatabase> | undefined;
	const db = () => (dbPromise ??= openChatDb());

	async function store(mode: IDBTransactionMode) {
		return (await db()).transaction(STORE_NAME, mode).objectStore(STORE_NAME);
	}

	/**
	 * Migration reader: import the chat rows a previous build persisted in
	 * the workspace Y.Doc, then delete them so their content is garbage
	 * collected out of the doc. Runs lazily on each conversation's first
	 * `getItem`; every conversation handle hydrates at startup, so the
	 * table drains on this build's first run.
	 *
	 * The cast is the same contract the old ui-message.ts boundary
	 * documented: parts were produced by TanStack AI and round-tripped
	 * losslessly through Y.Doc JSON.
	 */
	function importLegacyDocMessages(id: string): UIMessage[] | undefined {
		const rows = tabManager.tables.chatMessages
			.filter((m) => m.conversationId === id)
			.sort((a, b) => a.createdAt - b.createdAt);
		if (rows.length === 0) return undefined;
		const messages = rows.map(
			(row): UIMessage => ({
				id: row.id,
				role: row.role,
				parts: row.parts as unknown as UiMessagePart[],
				createdAt: new Date(row.createdAt),
			}),
		);
		tabManager.ydoc.transact(() => {
			for (const row of rows) {
				tabManager.tables.chatMessages.delete(row.id);
			}
		});
		return messages;
	}

	return {
		async getItem(id) {
			try {
				const stored = await requestToPromise<UIMessage[] | undefined>(
					(await store('readonly')).get(id),
				);
				if (stored) return stored;
				const imported = importLegacyDocMessages(id);
				if (imported) {
					await requestToPromise((await store('readwrite')).put(imported, id));
				}
				return imported ?? null;
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
}
