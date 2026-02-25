/**
 * Factory for creating self-contained, reactive conversation handles.
 *
 * Each handle owns its chat instance (lazy), derives metadata from the
 * shared conversations array, and holds ephemeral UI state (`$state`).
 * The baked-in `conversationId` means actions always target the correct
 * conversation — even from async callbacks and `onFinish`.
 *
 * Uses dependency injection so the handle doesn't close over singleton state.
 *
 * @see {@link createConversationHandle}
 */

import { generateId } from '@epicenter/hq';
import type { CreateChatReturn, UIMessage } from '@tanstack/ai-svelte';
import { createChat, fetchServerSentEvents } from '@tanstack/ai-svelte';
import { TAB_MANAGER_SYSTEM_PROMPT } from '$lib/ai/system-prompt';
import { tabManagerClientTools } from '$lib/ai/tools/client';
import { allServerToolDefinitions } from '$lib/ai/tools/definitions';
import {
	DEFAULT_PROVIDER,
	DEFAULT_MODEL,
	PROVIDER_MODELS,
	type Provider,
} from '$lib/ai/providers';
import type {
	ChatMessageId,
	ConversationId,
	Conversation,
} from '$lib/workspace';
import { popupWorkspace } from '$lib/workspace-popup';

// ─────────────────────────────────────────────────────────────────────────────
// Dependency Interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dependencies injected into each conversation handle.
 *
 * These are provided by the orchestrator (`chat-state.svelte.ts`) so
 * handles don't close over singleton state directly.
 */
export interface ConversationHandleDeps {
	getConversations: () => Conversation[];
	updateConversation: (
		id: ConversationId,
		patch: Partial<Omit<Conversation, 'id'>>,
	) => void;
	deleteConversation: (id: ConversationId) => void;
	loadMessages: (id: ConversationId) => UIMessage[];
	getHubUrl: () => string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Handle Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a reactive handle for a single conversation.
 *
 * Each handle owns its chat instance (lazy), derives metadata from the
 * shared `conversations` array, and holds ephemeral UI state (`$state`).
 * The baked-in `conversationId` means actions always target the correct
 * conversation — even from async callbacks and `onFinish`.
 *
 * Follows the same `$state`-inside-factory pattern as `useCombobox()` in
 * `packages/ui/src/hooks/use-combobox.svelte.ts`. Getter/setter pairs
 * backed by `$state` are fully reactive and work with `bind:value`.
 *
 * @example
 * ```typescript
 * const conv = aiChatState.get(conversationId);
 * conv.messages;        // reactive message list (lazy ChatClient creation)
 * conv.isLoading;       // streaming state (no ChatClient creation)
 * conv.inputValue;      // per-conversation draft (preserved across switches)
 * conv.sendMessage();   // action, scoped to this conversation
 * ```
 */
export function createConversationHandle(
	conversationId: ConversationId,
	deps: ConversationHandleDeps,
) {
	let chatInstance: CreateChatReturn | undefined;

	/**
	 * Get or create the ChatClient for this conversation.
	 *
	 * Lazily creates instances on first access. The connection callback
	 * reads the conversation's provider/model at request time (not creation
	 * time) so provider/model changes take effect on the next send.
	 */
	function ensureChat(): CreateChatReturn {
		if (chatInstance) return chatInstance;

		chatInstance = createChat({
			initialMessages: deps.loadMessages(conversationId),
			tools: tabManagerClientTools,
			connection: fetchServerSentEvents(
				() => `${deps.getHubUrl()}/ai/chat`,
				async () => {
					const conv = deps
						.getConversations()
						.find((c) => c.id === conversationId);
					return {
						body: {
							provider: conv?.provider ?? DEFAULT_PROVIDER,
							model: conv?.model ?? DEFAULT_MODEL,
							conversationId,
							systemPrompt:
								conv?.systemPrompt ?? TAB_MANAGER_SYSTEM_PROMPT,
							tools: allServerToolDefinitions,
						},
					};
				},
			),
			onFinish: (message) => {
				popupWorkspace.tables.chatMessages.set({
					id: message.id as string as ChatMessageId,
					conversationId,
					role: 'assistant',
					parts: message.parts,
					createdAt: message.createdAt?.getTime() ?? Date.now(),
					_v: 1,
				});
				// Touch conversation's updatedAt so it floats to top of list
				deps.updateConversation(conversationId, {});
			},
		});

		return chatInstance;
	}

	// ── Ephemeral UI state ──
	let inputValue = $state('');
	let dismissedError = $state<string | null>(null);

	// ── Derived metadata ──
	// Re-derives whenever `conversations` array updates (via Y.Doc observer).
	// Handles are always in sync with Y.Doc without any manual sync logic.
	const metadata = $derived(
		deps.getConversations().find((c) => c.id === conversationId),
	);

	return {
		// ── Identity ──

		/** The conversation's unique ID (baked in via closure). */
		get id() {
			return conversationId;
		},

		// ── Y.Doc-backed metadata (derived from conversations array) ──

		/** Conversation title — reactive, re-derives when Y.Doc changes. */
		get title() {
			return metadata?.title ?? 'New Chat';
		},

		/**
		 * Provider name — reactive.
		 *
		 * Setting auto-selects the first model for the new provider so
		 * the user always has a valid model selected after switching.
		 */
		get provider() {
			return metadata?.provider ?? DEFAULT_PROVIDER;
		},
		set provider(value: string) {
			const models = PROVIDER_MODELS[value as Provider];
			deps.updateConversation(conversationId, {
				provider: value,
				model: models?.[0] ?? DEFAULT_MODEL,
			});
		},

		/** Model name — reactive. */
		get model() {
			return metadata?.model ?? DEFAULT_MODEL;
		},
		set model(value: string) {
			deps.updateConversation(conversationId, { model: value });
		},

		/** System prompt override — reactive. */
		get systemPrompt() {
			return metadata?.systemPrompt;
		},

		/** Creation timestamp in milliseconds. */
		get createdAt() {
			return metadata?.createdAt ?? 0;
		},

		/** Last updated timestamp in milliseconds. */
		get updatedAt() {
			return metadata?.updatedAt ?? 0;
		},

		/** Parent conversation ID (for sub-conversations). */
		get parentId() {
			return metadata?.parentId;
		},

		/** Source message ID that spawned this conversation. */
		get sourceMessageId() {
			return metadata?.sourceMessageId;
		},

		// ── TanStack AI chat (lazy on messages/sendMessage access) ──

		/**
		 * The conversation's messages (reactive).
		 *
		 * Accessing this lazily creates the ChatClient if it doesn't exist.
		 * TanStack AI returns reactive getters — no `$` prefix needed.
		 */
		get messages() {
			return ensureChat().messages;
		},

		/**
		 * Whether a response is currently streaming.
		 *
		 * Returns false if the ChatClient hasn't been created yet
		 * (conversation was never opened by the user). Does NOT trigger
		 * lazy ChatClient creation — safe to call from conversation list.
		 */
		get isLoading() {
			return chatInstance?.isLoading ?? false;
		},

		/**
		 * The latest stream error, if any.
		 *
		 * Returns undefined if no ChatClient exists or no error occurred.
		 * Does NOT trigger lazy ChatClient creation.
		 */
		get error() {
			return chatInstance?.error ?? undefined;
		},

		/**
		 * Fine-grained connection status.
		 *
		 * More granular than `isLoading` — distinguishes between idle,
		 * streaming, and other states. Returns 'ready' if no ChatClient
		 * exists yet. Does NOT trigger lazy ChatClient creation.
		 */
		get status() {
			return chatInstance?.status ?? 'ready';
		},

		// ── Ephemeral UI state ($state, in-memory) ──

		/**
		 * Per-conversation input draft — preserved across switches.
		 *
		 * Stored in-memory only (not in Y.Doc). Lost on extension reload,
		 * which is acceptable for ephemeral drafts. Uses the same
		 * `$state`-inside-factory pattern as `useCombobox()` — works
		 * with `bind:value`.
		 */
		get inputValue() {
			return inputValue;
		},
		set inputValue(value: string) {
			inputValue = value;
		},

		/**
		 * Dismissed error message — per-conversation.
		 *
		 * Switching back to a conversation won't re-show an error
		 * you already dismissed.
		 */
		get dismissedError() {
			return dismissedError;
		},
		set dismissedError(value: string | null) {
			dismissedError = value;
		},

		// ── Derived convenience ──

		/**
		 * Short preview of the last message in this conversation.
		 *
		 * Queries Y.Doc directly — works without creating a ChatClient.
		 * Returns the first 60 characters of text content, or empty string.
		 */
		get lastMessagePreview() {
			const messages = popupWorkspace.tables.chatMessages
				.filter((m) => m.conversationId === conversationId)
				.sort((a, b) => b.createdAt - a.createdAt);
			const last = messages[0];
			if (!last) return '';
			const parts = last.parts as Array<{
				type: string;
				content?: string;
			}>;
			const text = parts
				.filter((p) => p.type === 'text')
				.map((p) => p.content ?? '')
				.join('')
				.trim();
			return text.length > 60 ? text.slice(0, 60) + '\u2026' : text;
		},

		// ── Actions ──

		/**
		 * Send a user message and begin streaming the assistant response.
		 *
		 * Renames the conversation from "New Chat" to the first message's
		 * text (truncated to 50 chars). Persists the user message to Y.Doc
		 * before sending, and the assistant response via `onFinish`.
		 */
		sendMessage(content: string) {
			if (!content.trim()) return;
			const userMessageId = generateId() as string as ChatMessageId;
			popupWorkspace.tables.chatMessages.set({
				id: userMessageId,
				conversationId,
				role: 'user',
				parts: [{ type: 'text', content }],
				createdAt: Date.now(),
				_v: 1,
			});

			const conv = deps
				.getConversations()
				.find((c) => c.id === conversationId);
			deps.updateConversation(conversationId, {
				title:
					conv?.title === 'New Chat'
						? content.trim().slice(0, 50)
						: conv?.title,
			});

			void ensureChat().sendMessage({
				content,
				id: userMessageId,
			});
		},

		/**
		 * Regenerate the last assistant message.
		 *
		 * Deletes the old assistant message from Y.Doc, then calls
		 * `reload()` which re-requests a response from the server.
		 * The new response is persisted via `onFinish`.
		 */
		reload() {
			const chat = ensureChat();
			const lastMessage = chat.messages.at(-1);
			if (lastMessage?.role === 'assistant') {
				popupWorkspace.tables.chatMessages.delete(
					lastMessage.id as string as ChatMessageId,
				);
			}
			void chat.reload();
		},

		/** Stop this conversation's streaming response. */
		stop() {
			chatInstance?.stop();
		},

		/**
		 * Rename this conversation.
		 *
		 * Writes to Y.Doc — the observer propagates the change reactively.
		 */
		rename(title: string) {
			deps.updateConversation(conversationId, { title });
		},

		/**
		 * Delete this conversation and all its messages.
		 *
		 * Delegates to the singleton's delete logic which handles
		 * stopping the stream, Y.Doc cleanup, and switching away
		 * if this was the active conversation.
		 */
		delete() {
			deps.deleteConversation(conversationId);
		},

		/**
		 * Refresh messages from Y.Doc for idle instances.
		 *
		 * Called on conversation switch and by the chatMessages observer.
		 * Skips refresh if the ChatClient is currently streaming
		 * (the in-progress assistant message isn't in Y.Doc yet).
		 * Also skips if no ChatClient exists (nothing to refresh).
		 */
		refreshFromDoc() {
			if (!chatInstance || chatInstance.isLoading) return;
			chatInstance.setMessages(deps.loadMessages(conversationId));
		},
	};
}

/**
 * A self-contained, reactive handle for a single conversation.
 *
 * Owns its chat instance (lazy), metadata derivation (from Y.Doc),
 * ephemeral UI state, and all per-conversation actions.
 *
 * @see {@link createConversationHandle} for the factory function.
 */
export type ConversationHandle = ReturnType<typeof createConversationHandle>;
