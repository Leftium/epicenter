/**
 * Reactive AI chat state with multi-conversation support.
 *
 * Each conversation is represented by a `ConversationHandle` — a self-contained
 * reactive object that owns its chat instance, metadata derivation, input draft,
 * dismissed error, and actions.
 *
 * The module-level singleton (`aiChatState`) is a thin orchestrator: a Map of
 * handles, an active pointer, conversation CRUD, and global config.
 *
 * Background streaming is free: each handle owns its own ChatClient. When the
 * user switches away from a streaming conversation, its ChatClient keeps
 * streaming. The completed response appears in Y.Doc via that instance's
 * `onFinish`.
 *
 * @example
 * ```svelte
 * <script>
 *   import { aiChatState } from '$lib/state/chat-state.svelte';
 * </script>
 *
 * {#each aiChatState.conversations as conv (conv.id)}
 *   <button onclick={() => aiChatState.switchTo(conv.id)}>
 *     {conv.title}
 *   </button>
 * {/each}
 *
 * {#each aiChatState.active?.messages ?? [] as message (message.id)}
 *   <ChatBubble {message} />
 * {/each}
 * ```
 */

import { generateId } from '@epicenter/hq';
import {
	ChatClient,
	fetchServerSentEvents,
	type ChatClientState,
	type UIMessage,
} from '@tanstack/ai-client';
import {
	AVAILABLE_PROVIDERS,
	DEFAULT_MODEL,
	DEFAULT_PROVIDER,
	PROVIDER_MODELS,
	type Provider,
} from '$lib/ai/providers';
import { TAB_MANAGER_SYSTEM_PROMPT } from '$lib/ai/system-prompt';
import { tabManagerClientTools } from '$lib/ai/tools/client';
import { allServerToolDefinitions } from '$lib/ai/tools/definitions';
import { toUiMessage } from '$lib/ai/ui-message';
import { getHubServerUrl } from '$lib/state/settings';
import type {
	ChatMessageId,
	Conversation,
	ConversationId,
} from '$lib/workspace';
import { popupWorkspace } from '$lib/workspace-popup';

// ─────────────────────────────────────────────────────────────────────────────
// Hub Server URL Cache
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cached hub server URL for synchronous access.
 *
 * `fetchServerSentEvents` requires a synchronous URL getter (`string | (() => string)`).
 * We initialize with the default and update asynchronously from settings.
 * AI chat routes through the hub server (auth + AI + keys), not the local server.
 */
let hubUrlCache = 'http://127.0.0.1:3913';
void getHubServerUrl().then((url) => {
	hubUrlCache = url;
});

// ─────────────────────────────────────────────────────────────────────────────
// State Factory
// ─────────────────────────────────────────────────────────────────────────────

/** Generate a new branded ConversationId from a random ID. */
const generateConversationId = () => generateId() as string as ConversationId;

function createAiChatState() {
	// ── Conversation List (Y.Doc-backed) ──────────────────────────────

	/** Read all conversations sorted by most recently updated first. */
	const readAllConversations = (): Conversation[] =>
		popupWorkspace.tables.conversations
			.getAllValid()
			.sort((a, b) => b.updatedAt - a.updatedAt);

	let conversations = $state<Conversation[]>(readAllConversations());

	/**
	 * Ensure at least one conversation exists.
	 *
	 * Called after persistence loads and in the conversations observer.
	 * Safe to call multiple times — only creates if truly empty.
	 */
	function ensureDefaultConversation(): ConversationId | undefined {
		if (conversations.length > 0) return undefined;
		const id = generateConversationId();
		const now = Date.now();
		popupWorkspace.tables.conversations.set({
			id,
			title: 'New Chat',
			provider: DEFAULT_PROVIDER,
			model: DEFAULT_MODEL,
			createdAt: now,
			updatedAt: now,
			_v: 1,
		});
		conversations = readAllConversations();
		return id;
	}

	// ── Helpers ───────────────────────────────────────────────────────

	/**
	 * Update a conversation's fields and touch `updatedAt`.
	 *
	 * Uses `TableHelper.update()` for atomic read-merge-write.
	 * Safe to call from streaming callbacks and async contexts
	 * where the conversation may have been deleted.
	 */
	function updateConversation(
		conversationId: ConversationId,
		patch: Partial<Omit<Conversation, 'id'>>,
	) {
		popupWorkspace.tables.conversations.update(conversationId, {
			...patch,
			updatedAt: Date.now(),
		});
	}

	/** Load persisted messages for a conversation from Y.Doc. */
	function loadMessages(conversationId: ConversationId) {
		return popupWorkspace.tables.chatMessages
			.filter((m) => m.conversationId === conversationId)
			.sort((a, b) => a.createdAt - b.createdAt)
			.map(toUiMessage);
	}

	// ── Conversation Handle Factory ──────────────────────────────────

	/**
	 * Create a reactive handle for a single conversation.
	 *
	 * Each handle owns its chat instance (lazy), derives metadata from the
	 * shared `conversations` array, and holds ephemeral UI state (`$state`).
	 * The baked-in `conversationId` means actions always target the correct
	 * conversation — even from async callbacks and `onFinish`.
	 *
	 * Closes over the orchestrator's state directly — no dependency
	 * injection needed since the handle lives inside the same closure.
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
	function createConversationHandle(conversationId: ConversationId) {
		let chatInstance: ChatClient | undefined;

		// ── Owned reactive state ──
		// These $state variables live in OUR .svelte.ts file (guaranteed compiled).
		// ChatClient writes to them via callbacks — Svelte subscribes to them in templates.
		let messages = $state<UIMessage[]>(loadMessages(conversationId));
		let isLoading = $state(false);
		let error = $state<Error | undefined>(undefined);
		let status = $state<ChatClientState>('ready');

		/**
		 * Get or create the ChatClient for this conversation.
		 *
		 * Lazily creates instances on first access. The connection callback
		 * reads the conversation's provider/model at request time (not creation
		 * time) so provider/model changes take effect on the next send.
		 */
		function ensureChat(): ChatClient {
			if (chatInstance) return chatInstance;

			chatInstance = new ChatClient({
				initialMessages: loadMessages(conversationId),
				tools: tabManagerClientTools,
				connection: fetchServerSentEvents(
					() => `${hubUrlCache}/ai/chat`,
					async () => {
						const conv = conversations.find(
							(c) => c.id === conversationId,
						);
						return {
							body: {
								provider: conv?.provider ?? DEFAULT_PROVIDER,
								model: conv?.model ?? DEFAULT_MODEL,
								conversationId,
								systemPrompt:
									conv?.systemPrompt ??
									TAB_MANAGER_SYSTEM_PROMPT,
								tools: allServerToolDefinitions,
							},
						};
					},
				),
				onMessagesChange: (m) => (messages = m),
				onLoadingChange: (l) => (isLoading = l),
				onErrorChange: (e) => (error = e),
				onStatusChange: (s) => (status = s),
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
					updateConversation(conversationId, {});
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
			conversations.find((c) => c.id === conversationId),
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
				updateConversation(conversationId, {
					provider: value,
					model: models?.[0] ?? DEFAULT_MODEL,
				});
			},

			/** Model name — reactive. */
			get model() {
				return metadata?.model ?? DEFAULT_MODEL;
			},
			set model(value: string) {
				updateConversation(conversationId, { model: value });
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
			 * Reads from our owned `$state` — guaranteed compiled, guaranteed reactive.
			 */
			get messages() {
				ensureChat();
				return messages;
			},

			/**
			 * Whether a response is currently streaming.
			 *
			 * Reads from our owned `$state` — reactive without ChatClient creation.
			 * Safe to call from conversation list (defaults to `false`).
			 */
			get isLoading() {
				return isLoading;
			},

			/**
			 * The latest stream error, if any.
			 *
			 * Reads from our owned `$state` — reactive without ChatClient creation.
			 */
			get error() {
				return error;
			},

			/**
			 * Fine-grained connection status.
			 *
			 * More granular than `isLoading` — distinguishes between idle,
			 * streaming, and other states. Reads from our owned `$state`.
			 */
			get status() {
				return status;
			},

			// ── Ephemeral UI state ($state, in-memory) ──

			/**
			 * Per-conversation input draft — preserved across switches.
			 *
			 * Stored in-memory only (not in Y.Doc). Lost on extension reload,
			 * which is acceptable for ephemeral drafts. Works with `bind:value`.
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
				const msgs = popupWorkspace.tables.chatMessages
					.filter((m) => m.conversationId === conversationId)
					.sort((a, b) => b.createdAt - a.createdAt);
				const last = msgs[0];
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
				return text.length > 60
					? text.slice(0, 60) + '\u2026'
					: text;
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
				const userMessageId =
					generateId() as string as ChatMessageId;
				popupWorkspace.tables.chatMessages.set({
					id: userMessageId,
					conversationId,
					role: 'user',
					parts: [{ type: 'text', content }],
					createdAt: Date.now(),
					_v: 1,
				});

				const conv = conversations.find(
					(c) => c.id === conversationId,
				);
				updateConversation(conversationId, {
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
				const lastMessage = messages.at(-1);
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
				updateConversation(conversationId, { title });
			},

			/**
			 * Delete this conversation and all its messages.
			 *
			 * Delegates to the orchestrator's delete logic which handles
			 * stopping the stream, Y.Doc cleanup, and switching away
			 * if this was the active conversation.
			 */
			delete() {
				deleteConversation(conversationId);
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
				if (!chatInstance || isLoading) return;
				chatInstance.setMessagesManually(
					loadMessages(conversationId),
				);
			},
		};
	}

	// ── Conversation Handles ─────────────────────────────────────────

	const handles = new Map<
		ConversationId,
		ReturnType<typeof createConversationHandle>
	>();

	/**
	 * Sync handles Map with the conversations array.
	 *
	 * Creates handles for new conversation IDs, removes (and stops)
	 * handles for deleted IDs. Existing handles survive — their
	 * ChatClient and ephemeral state (drafts, dismissed errors) persist.
	 */
	function reconcileHandles() {
		const currentIds = new Set(conversations.map((c) => c.id));

		for (const [id, handle] of handles) {
			if (!currentIds.has(id)) {
				handle.stop();
				handles.delete(id);
			}
		}

		for (const conv of conversations) {
			if (!handles.has(conv.id)) {
				handles.set(conv.id, createConversationHandle(conv.id));
			}
		}
	}

	// ── Active Conversation ──────────────────────────────────────────

	/**
	 * The active conversation ID.
	 *
	 * May briefly be invalid before Y.Doc persistence loads — the `active`
	 * getter returns undefined in that case.
	 */
	let activeConversationId = $state<ConversationId>(
		(conversations[0]?.id ?? '') as ConversationId,
	);

	// ── Observers ────────────────────────────────────────────────────

	// Re-read and reconcile on every Y.Doc conversation change.
	// Observer fires synchronously on local writes, so handles are
	// always up-to-date before subsequent code runs.
	popupWorkspace.tables.conversations.observe(() => {
		conversations = readAllConversations();
		reconcileHandles();
	});

	// Initial reconciliation for conversations loaded before the observer.
	reconcileHandles();

	// Defer default conversation creation until Y.Doc persistence loads.
	// Before this resolves, conversations may be empty — the UI handles
	// this gracefully by showing the empty state.
	void popupWorkspace.whenReady.then(() => {
		conversations = readAllConversations();
		reconcileHandles();
		const newId = ensureDefaultConversation();
		// Point active to first real conversation after persistence merge
		if (conversations.length > 0) {
			activeConversationId = newId ?? conversations[0].id;
		}
	});

	// Refresh active conversation's messages when Y.Doc changes
	// (e.g. background stream completion via onFinish).
	// Non-active conversations get refreshed on switch via switchConversation.
	popupWorkspace.tables.chatMessages.observe(() => {
		handles.get(activeConversationId)?.refreshFromDoc();
	});

	// ── Conversation CRUD ────────────────────────────────────────────

	/**
	 * Create a new conversation and switch to it.
	 *
	 * Inherits provider/model from the current conversation so new
	 * threads continue with the user's preferred settings.
	 *
	 * @returns The new conversation's ID.
	 */
	function createConversation(opts?: {
		title?: string;
		parentId?: ConversationId;
		sourceMessageId?: ChatMessageId;
		systemPrompt?: string;
	}): ConversationId {
		const id = generateConversationId();
		const now = Date.now();
		const current = handles.get(activeConversationId);

		popupWorkspace.tables.conversations.set({
			id,
			title: opts?.title ?? 'New Chat',
			parentId: opts?.parentId,
			sourceMessageId: opts?.sourceMessageId,
			systemPrompt: opts?.systemPrompt,
			provider: current?.provider ?? DEFAULT_PROVIDER,
			model: current?.model ?? DEFAULT_MODEL,
			createdAt: now,
			updatedAt: now,
			_v: 1,
		});

		switchConversation(id);
		return id;
	}

	/**
	 * Switch to a different conversation.
	 *
	 * Changes which conversation the `active` getter returns. If the
	 * target conversation is idle, refreshes its messages from Y.Doc.
	 * If the previous conversation was streaming, it continues in the
	 * background — each handle owns its own ChatClient.
	 */
	function switchConversation(conversationId: ConversationId) {
		activeConversationId = conversationId;
		handles.get(conversationId)?.refreshFromDoc();
	}

	/**
	 * Delete a conversation and all its messages.
	 *
	 * Uses a Y.Doc batch so the observer fires once (not N+1 times).
	 * Stops any active stream and removes the handle. If the deleted
	 * conversation was active, switches to the most recent remaining
	 * one (or creates a fresh one).
	 */
	function deleteConversation(conversationId: ConversationId) {
		const handle = handles.get(conversationId);
		if (handle) {
			handle.stop();
			handles.delete(conversationId);
		}

		const msgs = popupWorkspace.tables.chatMessages
			.getAllValid()
			.filter((m) => m.conversationId === conversationId);
		popupWorkspace.batch(() => {
			for (const m of msgs) {
				popupWorkspace.tables.chatMessages.delete(m.id);
			}
			popupWorkspace.tables.conversations.delete(conversationId);
		});

		// Switch away if we deleted the active conversation
		if (activeConversationId === conversationId) {
			const remaining = popupWorkspace.tables.conversations
				.getAllValid()
				.sort((a, b) => b.updatedAt - a.updatedAt);
			const first = remaining[0];
			if (first) {
				switchConversation(first.id);
			} else {
				// Last conversation deleted — create a replacement
				createConversation();
			}
		}
	}

	// ── Public API ────────────────────────────────────────────────────

	return {
		// ── Handle Access ────────────────────────────────────────────

		/**
		 * The active conversation's handle.
		 *
		 * Returns undefined before persistence loads. Components should
		 * use optional chaining or guard with `{#if}`:
		 *
		 * @example
		 * ```svelte
		 * {#if aiChatState.active}
		 *   {@const active = aiChatState.active}
		 *   <Textarea bind:value={active.inputValue} />
		 * {/if}
		 * ```
		 */
		get active() {
			return handles.get(activeConversationId);
		},

		/**
		 * All conversations as handles, sorted by most recently updated first.
		 *
		 * Each item is a full ConversationHandle — access `.isLoading`,
		 * `.lastMessagePreview`, `.inputValue` directly without secondary lookup.
		 *
		 * Reactive through the underlying `$state` conversations array:
		 * when Y.Doc changes, this getter returns fresh results.
		 */
		get conversations() {
			return conversations
				.map((c) => handles.get(c.id))
				.filter(
					(h): h is ReturnType<typeof createConversationHandle> =>
						h !== undefined,
				);
		},

		/**
		 * Get a handle by conversation ID.
		 *
		 * Returns undefined if the conversation doesn't exist.
		 *
		 * @example
		 * ```typescript
		 * const conv = aiChatState.get(conversationId);
		 * conv?.sendMessage('Hello');
		 * ```
		 */
		get(id: ConversationId) {
			return handles.get(id);
		},

		/** The active conversation's ID (always set, may be stale before persistence loads). */
		get activeConversationId() {
			return activeConversationId;
		},

		// ── Conversation CRUD ────────────────────────────────────────

		createConversation,

		/**
		 * Switch to a different conversation.
		 *
		 * Updates the active pointer and refreshes idle instances from Y.Doc.
		 */
		switchTo(conversationId: ConversationId) {
			switchConversation(conversationId);
		},

		// ── Provider / Model (global config) ─────────────────────────

		/** List of available provider names. */
		get availableProviders() {
			return AVAILABLE_PROVIDERS;
		},

		/**
		 * Get the curated model list for a given provider.
		 *
		 * @example
		 * ```typescript
		 * aiChatState.modelsForProvider('openai')
		 * // → ['gpt-4o', 'gpt-4o-mini', 'o3-mini']
		 * ```
		 */
		modelsForProvider(providerName: string): readonly string[] {
			return PROVIDER_MODELS[providerName as Provider] ?? [];
		},
	};
}

export const aiChatState = createAiChatState();

/**
 * A self-contained, reactive handle for a single conversation.
 *
 * Owns its chat instance (lazy), metadata derivation (from Y.Doc),
 * ephemeral UI state, and all per-conversation actions.
 */
export type ConversationHandle = NonNullable<
	ReturnType<(typeof aiChatState)['get']>
>;
