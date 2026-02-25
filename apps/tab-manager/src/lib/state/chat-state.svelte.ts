/**
 * Reactive AI chat state with multi-conversation support.
 *
 * Each conversation is represented by a `ConversationHandle` — a factory-created,
 * self-contained reactive object that owns its chat instance, metadata derivation,
 * input draft, dismissed error, and actions. The singleton is a thin orchestrator:
 * a Map of handles, an active pointer, conversation CRUD, and global config.
 *
 * Background streaming is free: each handle owns its own ChatClient. When the user
 * switches away from a streaming conversation, its ChatClient keeps streaming.
 * The completed response appears in Y.Doc via that instance's `onFinish`.
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
	DEFAULT_PROVIDER,
	DEFAULT_MODEL,
	AVAILABLE_PROVIDERS,
	PROVIDER_MODELS,
	type Provider,
} from '$lib/ai/providers';
import { toUiMessage } from '$lib/ai/ui-message';
import {
	createConversationHandle,
	type ConversationHandle,
	type ConversationHandleDeps,
} from '$lib/state/conversation-handle.svelte';
import { getHubServerUrl } from '$lib/state/settings';
import type {
	ChatMessageId,
	ConversationId,
	Conversation,
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
	function loadMessagesForConversation(conversationId: ConversationId) {
		return popupWorkspace.tables.chatMessages
			.filter((m) => m.conversationId === conversationId)
			.sort((a, b) => a.createdAt - b.createdAt)
			.map(toUiMessage);
	}

	// ── Dependency Injection ─────────────────────────────────────────

	/** Dependencies wired from closure variables for conversation handles. */
	const deps: ConversationHandleDeps = {
		getConversations: () => conversations,
		updateConversation,
		deleteConversation,
		loadMessages: loadMessagesForConversation,
		getHubUrl: () => hubUrlCache,
	};

	// ── Conversation Handles ─────────────────────────────────────────

	const handles = new Map<ConversationId, ConversationHandle>();

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
				handles.set(conv.id, createConversationHandle(conv.id, deps));
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

		const messages = popupWorkspace.tables.chatMessages
			.getAllValid()
			.filter((m) => m.conversationId === conversationId);
		popupWorkspace.batch(() => {
			for (const m of messages) {
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
				.filter((h): h is ConversationHandle => h !== undefined);
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

export type { ConversationHandle };
