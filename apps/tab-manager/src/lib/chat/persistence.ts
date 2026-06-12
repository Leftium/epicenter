/**
 * Extension-local chat store.
 *
 * Chat is fully device-local. One IndexedDB database, two stores:
 *
 * - `messages`: conversationId -> UIMessage[], written by the TanStack AI
 *   chat client through the {@link chatPersistence} adapter (full list on
 *   every change through the client's ordered write queue).
 * - `settings`: conversationId -> {@link ModelChoice}, the per-conversation
 *   provider/model pick, written by the conversation handles.
 *
 * The conversation list is derived from this store: a conversation exists
 * once its first message lands (drafts live in memory only), its title and
 * timestamps derive from the messages themselves, and deleting it removes
 * both rows. Nothing about chat lives in the synced workspace: transcripts
 * are single-writer, device-scoped logs, and a future local-model path
 * means a turn may never touch the server, so CRDT storage would pay
 * tombstone and sync costs for no conflict-resolution benefit.
 *
 * UIMessage is structured-clone friendly (Date survives the round trip),
 * so messages store and load verbatim with no serialization layer. Parts
 * persisted by a newer build than the reader render through the
 * unknown-part fallback in MessageParts.svelte. The chat client swallows
 * adapter errors by design, so failures are logged here before degrading
 * to an empty history.
 */

import type { ChatClientPersistence, UIMessage } from '@tanstack/ai-client';
import { generateId, type Id } from '@epicenter/workspace';
import type { Brand } from 'wellcrafted/brand';

// ── Conversation identity ──────────────────────────────────────────────
// The brand lives here because the chat store owns the key space; chat is
// not a workspace concern.

/** Branded conversation ID: nanoid generated when a conversation is created. */
export type ConversationId = Id & Brand<'ConversationId'>;

/** Generate a unique {@link ConversationId} for a new conversation. */
export const generateConversationId = (): ConversationId =>
	generateId() as ConversationId;

/**
 * Syntactic sugar for `value as ConversationId`. The constrained `string`
 * parameter is what earns it over a raw `as` cast (callers can't widen to
 * `unknown`). The only place in the codebase where `as ConversationId`
 * should appear.
 */
export const asConversationId = (value: string): ConversationId =>
	value as ConversationId;

/** The per-conversation provider/model pick. */
export type ModelChoice = { provider: string; model: string };

// ── IndexedDB plumbing ─────────────────────────────────────────────────

const DB_NAME = 'tab-manager-chat';
const DB_VERSION = 2;
const MESSAGES_STORE = 'messages';
const SETTINGS_STORE = 'settings';

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

let dbPromise: Promise<IDBDatabase> | undefined;

function store(
	name: typeof MESSAGES_STORE | typeof SETTINGS_STORE,
	mode: IDBTransactionMode,
): Promise<IDBObjectStore> {
	dbPromise ??= (() => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			// Clean break from the v1 single-store layout: recreate from
			// scratch rather than migrate (no data contract on this store).
			for (const existing of [...db.objectStoreNames]) {
				db.deleteObjectStore(existing);
			}
			db.createObjectStore(MESSAGES_STORE);
			db.createObjectStore(SETTINGS_STORE);
		};
		return requestToPromise(request);
	})();
	return dbPromise.then((db) =>
		db.transaction(name, mode).objectStore(name),
	);
}

// ── Message bodies: the ChatClientPersistence adapter ──────────────────

export const chatPersistence = {
	async getItem(id) {
		try {
			const messages = await requestToPromise<UIMessage[] | undefined>(
				(await store(MESSAGES_STORE, 'readonly')).get(id),
			);
			return messages ?? null;
		} catch (error) {
			console.error('[ai-chat] failed to load chat history:', error);
			return null;
		}
	},
	async setItem(id, messages) {
		try {
			await requestToPromise(
				(await store(MESSAGES_STORE, 'readwrite')).put(messages, id),
			);
		} catch (error) {
			console.error('[ai-chat] failed to save chat history:', error);
		}
	},
	async removeItem(id) {
		try {
			await requestToPromise(
				(await store(MESSAGES_STORE, 'readwrite')).delete(id),
			);
		} catch (error) {
			console.error('[ai-chat] failed to delete chat history:', error);
		}
	},
} satisfies ChatClientPersistence;

// ── Startup enumeration and model-choice rows ──────────────────────────

/**
 * Read every stored conversation's messages in one pass. Used once at
 * startup to discover which conversations exist and pick the most recent;
 * each conversation's handle then hydrates its own copy through the
 * adapter.
 */
export async function loadAllConversations(): Promise<
	Array<{ id: ConversationId; messages: UIMessage[] }>
> {
	try {
		const messagesStore = await store(MESSAGES_STORE, 'readonly');
		const [keys, values] = await Promise.all([
			requestToPromise(messagesStore.getAllKeys()),
			requestToPromise<UIMessage[][]>(messagesStore.getAll()),
		]);
		return keys.map((key, i) => ({
			id: asConversationId(String(key)),
			messages: values[i] ?? [],
		}));
	} catch (error) {
		console.error('[ai-chat] failed to list conversations:', error);
		return [];
	}
}

/** Read every stored model choice in one pass, for startup hydration. */
export async function getAllModelChoices(): Promise<
	Map<ConversationId, ModelChoice>
> {
	try {
		const settingsStore = await store(SETTINGS_STORE, 'readonly');
		const [keys, values] = await Promise.all([
			requestToPromise(settingsStore.getAllKeys()),
			requestToPromise<ModelChoice[]>(settingsStore.getAll()),
		]);
		return new Map(
			keys.flatMap((key, i) => {
				const choice = values[i];
				return choice ? [[asConversationId(String(key)), choice] as const] : [];
			}),
		);
	} catch (error) {
		console.error('[ai-chat] failed to load model choices:', error);
		return new Map();
	}
}

export async function setModelChoice(
	id: ConversationId,
	choice: ModelChoice,
): Promise<void> {
	try {
		await requestToPromise(
			(await store(SETTINGS_STORE, 'readwrite')).put(choice, id),
		);
	} catch (error) {
		console.error('[ai-chat] failed to save model choice:', error);
	}
}

export async function deleteModelChoice(id: ConversationId): Promise<void> {
	try {
		await requestToPromise(
			(await store(SETTINGS_STORE, 'readwrite')).delete(id),
		);
	} catch (error) {
		console.error('[ai-chat] failed to delete model choice:', error);
	}
}
