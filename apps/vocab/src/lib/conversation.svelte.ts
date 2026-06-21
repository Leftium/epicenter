/**
 * Reactive state for one open conversation: the live turn streams in component
 * state, finished messages persist as LWW blobs.
 *
 * Vocab is capability-free (ADR-0043), so the open tab answers its own turns,
 * and the live answer needs nothing durable (re-asking is free). So a turn
 * streams straight into Svelte `$state` and never into the synced doc; only a
 * finished message is written to the conversation's LWW store (ADR-0046), keyed
 * by message id, the moment a normal app would POST the row: the user turn on
 * send, the assistant turn on a clean finish. On open we hydrate from the store
 * and observe it, so a message finished on another device shows up here.
 *
 * A stopped or failed turn writes nothing: the partial answer lives only in
 * state and is dropped, leaving the durable user turn to retry.
 */

import {
	generateMessageId,
	type MessageId,
	type VocabMessage,
} from '@epicenter/vocab';
import type { VocabChatStream } from '@epicenter/vocab/engine';
import type { KvStoreHandle } from '@epicenter/workspace';
import { EventType, type ModelMessage } from '@tanstack/ai';
import { extractErrorMessage } from 'wellcrafted/error';

/** The opened `conversations.messages` child-doc handle (keyed by message id). */
type MessageStore = KvStoreHandle<VocabMessage> & Disposable;

/**
 * Bind one conversation's message store to the inference stream.
 *
 * @param store  the opened `tables.conversations.docs.messages.open(id)` handle.
 * @param stream the client's inference backend (the metered Epicenter stream).
 */
export function createConversation(
	store: MessageStore,
	stream: VocabChatStream,
) {
	/** Read the durable transcript as a chronologically ordered array. */
	function readAll(): VocabMessage[] {
		return [...store.entries()]
			.map((entry) => entry.val)
			.sort((a, b) => a.createdAt - b.createdAt);
	}

	// The durable transcript, hydrated from the store and kept in sync with it.
	let persisted = $state<VocabMessage[]>(readAll());
	const unobserve = store.observe(() => {
		persisted = readAll();
	});

	// The in-flight assistant turn, component-only until it finishes. `id` is
	// minted up front so the streaming bubble and the persisted message share it.
	let streamingId = $state<MessageId | null>(null);
	let streamingText = $state('');
	let streamingStartedAt = 0;
	let error = $state<string | null>(null);
	let controller: AbortController | null = null;

	/** Freeze the durable transcript into a provider prompt, dropping empties. */
	function buildPrompt(): ModelMessage[] {
		return readAll()
			.map((message) => ({ role: message.role, content: message.text }))
			.filter((message) => message.content.length > 0);
	}

	/** Stream one assistant answer into state, persisting it on a clean finish. */
	async function runTurn(): Promise<void> {
		const id = generateMessageId();
		streamingId = id;
		streamingText = '';
		streamingStartedAt = Date.now();
		error = null;
		controller = new AbortController();
		const { signal } = controller;
		const prompt = buildPrompt();

		let failure: string | undefined;
		try {
			for await (const chunk of stream(prompt, signal)) {
				if (signal.aborted) break;
				if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) {
					streamingText += chunk.delta;
				} else if (chunk.type === EventType.RUN_ERROR) {
					failure = chunk.message;
				}
			}
		} catch (cause) {
			if (!signal.aborted) failure = extractErrorMessage(cause);
		}

		const aborted = signal.aborted;
		const text = streamingText;
		controller = null;

		// Persist before clearing the stream state so the message never blinks out
		// of the list: the store observer refreshes `persisted` synchronously, then
		// the streaming bubble (same id) clears in the same tick.
		if (!aborted && !failure) {
			store.set(id, {
				id,
				role: 'assistant',
				createdAt: streamingStartedAt,
				text,
			});
		}
		streamingId = null;
		streamingText = '';
		if (failure) error = failure;
	}

	// The transcript to render: durable messages plus the live turn, once it has
	// text. An empty in-flight turn shows as the typing bubble, not a message.
	const messages = $derived.by((): VocabMessage[] => {
		if (streamingId === null || streamingText.length === 0) return persisted;
		return [
			...persisted,
			{
				id: streamingId,
				role: 'assistant',
				createdAt: streamingStartedAt,
				text: streamingText,
			},
		];
	});

	return {
		get messages(): VocabMessage[] {
			return messages;
		},
		/** A turn is claimed but no token has arrived yet (show a typing bubble). */
		get isThinking(): boolean {
			return streamingId !== null && streamingText.length === 0;
		},
		/** A turn is in flight (disable input, offer stop). */
		get isGenerating(): boolean {
			return streamingId !== null;
		},
		/** The last turn's failure message, or null. Cleared on the next turn. */
		get error(): string | null {
			return error;
		},

		/** Persist the user turn and answer it. No-op on empty input or mid-turn. */
		send(content: string): void {
			const text = content.trim();
			if (!text || streamingId !== null) return;
			const id = generateMessageId();
			store.set(id, {
				id,
				role: 'user',
				createdAt: Date.now(),
				text,
			});
			void runTurn();
		},
		/** Abort the in-flight turn; the partial answer is dropped. */
		stop(): void {
			controller?.abort();
		},
		/** Re-answer the latest user turn after a failure. */
		retry(): void {
			if (streamingId !== null) return;
			void runTurn();
		},
		[Symbol.dispose](): void {
			controller?.abort();
			unobserve();
			store[Symbol.dispose]();
		},
	};
}
