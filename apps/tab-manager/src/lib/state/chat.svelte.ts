/**
 * Reactive AI chat state with multi-conversation support.
 *
 * Uses one TanStack AI `createChat()` instance per conversation, stored
 * in a Map. Each instance owns its own stream, messages, and lifecycle.
 * Switching conversations just changes which instance the getters read
 * from — no `setMessages()` swapping, no background stream tracking.
 *
 * Background streaming is free: when the user switches away from a
 * streaming conversation, its ChatClient keeps streaming. The completed
 * response appears in Y.Doc via that instance's `onFinish`. Multiple
 * conversations can stream concurrently.
 *
 * Provider and model are stored per-conversation in the `conversations`
 * table, surviving reloads and syncing across devices.
 *
 * @example
 * ```svelte
 * <script>
 *   import { aiChatState } from '$lib/state/chat.svelte';
 * </script>
 *
 * {#each aiChatState.conversations as conv (conv.id)}
 *   <button onclick={() => aiChatState.switchConversation(conv.id)}>
 *     {conv.title}
 *   </button>
 * {/each}
 *
 * {#each aiChatState.messages as message (message.id)}
 *   <ChatBubble {message} />
 * {/each}
 * ```
 */

import { generateId } from '@epicenter/hq';
import { ANTHROPIC_MODELS } from '@tanstack/ai-anthropic';
import { GeminiTextModels } from '@tanstack/ai-gemini';
import { GROK_CHAT_MODELS } from '@tanstack/ai-grok';
import { OPENAI_CHAT_MODELS } from '@tanstack/ai-openai';
import type { UIMessage } from '@tanstack/ai-svelte';
import { createChat, fetchServerSentEvents } from '@tanstack/ai-svelte';
import { getHubServerUrl } from '$lib/state/settings';
import type {
	ChatMessage,
	ChatMessageId,
	Conversation,
	ConversationId,
} from '$lib/workspace';
import { popupWorkspace } from '$lib/workspace-popup';

import { tabManagerClientTools } from '$lib/ai/tools/client';
import { allServerToolDefinitions } from '$lib/ai/tools/definitions';
import { TAB_MANAGER_SYSTEM_PROMPT } from '$lib/ai/system-prompt';
// ─────────────────────────────────────────────────────────────────────────────
// Provider / Model Configuration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Model arrays imported from TanStack AI provider packages.
 *
 * These are maintained by the TanStack AI team — no local hardcoded lists.
 * To update model lists, run: `bun update @tanstack/ai-openai @tanstack/ai-anthropic ...`
 *
 * Arrays are ordered newest-first by the upstream packages.
 */
const PROVIDER_MODELS = {
	openai: OPENAI_CHAT_MODELS,
	anthropic: ANTHROPIC_MODELS,
	gemini: GeminiTextModels,
	grok: GROK_CHAT_MODELS,
} as const;

type Provider = keyof typeof PROVIDER_MODELS;

const DEFAULT_PROVIDER: Provider = 'anthropic';
const DEFAULT_MODEL = PROVIDER_MODELS[DEFAULT_PROVIDER][0];
const AVAILABLE_PROVIDERS = Object.keys(PROVIDER_MODELS) as Provider[];

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

function createAiChatState() {
	// ── Conversation List (Y.Doc-backed) ──────────────────────────────

	/** Read all conversations sorted by most recently updated first. */
	const readAllConversations = (): Conversation[] =>
		popupWorkspace.tables.conversations
			.getAllValid()
			.sort((a, b) => b.updatedAt - a.updatedAt);

	let conversations = $state<Conversation[]>(readAllConversations());
	// Re-read on every Y.Doc change — observer fires on persistence load
	// and any subsequent remote/local modification.
	popupWorkspace.tables.conversations.observe(() => {
		conversations = readAllConversations();
	});

	// Ensure at least one conversation always exists. Creates a default
	// on first load so provider/model dropdowns always have a target.
	if (conversations.length === 0) {
		const id = generateId() as string as ConversationId;
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
	}
	// Refresh active conversation's messages when Y.Doc changes (e.g. background completion).
	// Non-active conversations get refreshed on switch via `switchConversation`.
	popupWorkspace.tables.chatMessages.observe(() => {
		const instance = chatInstances.get(activeConversationId);
		if (!instance || instance.isLoading) return;
		instance.setMessages(loadMessagesForConversation(activeConversationId));
	});
	// ── Active Conversation ───────────────────────────────────────────
	/** Always points to a valid conversation — guaranteed by eager creation. */
	let activeConversationId = $state<ConversationId>(conversations[0].id);

	/**
	 * Derived from `activeConversationId` + `conversations`.
	 *
	 * Re-evaluates when either changes — e.g. when provider/model is
	 * updated in the table, the observer fires, `conversations` updates,
	 * and this re-derives with the new metadata.
	 */
	const activeConversation = $derived(findConversation(activeConversationId));

	// ── Helpers ───────────────────────────────────────────────────────

	/**
	 * Find a conversation by ID — throws if not found.
	 *
	 * Safe because eager creation guarantees at least one conversation
	 * always exists, and `activeConversationId` is always valid.
	 */
	function findConversation(id: ConversationId): Conversation {
		const conv = conversations.find((c) => c.id === id);
		if (!conv) throw new Error(`Conversation ${id} not found`);
		return conv;
	}

	/**
	 * Get the active conversation by reading `$state` directly.
	 *
	 * Used in non-reactive contexts (async callbacks, event handlers)
	 * where `$derived` tracking isn't needed.
	 */
	const getActiveConversation = (): Conversation =>
		findConversation(activeConversationId);

	/** Load persisted messages for a conversation from Y.Doc. */
	const loadMessagesForConversation = (conversationId: ConversationId) =>
		popupWorkspace.tables.chatMessages
			.filter((m) => m.conversationId === conversationId)
			.sort((a, b) => a.createdAt - b.createdAt)
			.map(toUiMessage);

	// ── Per-Conversation ChatClient Instances ─────────────────────────

	/**
	 * Map of conversation ID → ChatClient instance.
	 *
	 * Each conversation gets its own `createChat()` instance with baked-in
	 * `conversationId` in the connection callback and `onFinish`. This means:
	 * - Background streaming is free (each instance owns its stream)
	 * - `onFinish` always persists to the correct conversation
	 * - No `setMessages()` swapping needed on conversation switch
	 * - Multiple conversations can stream concurrently
	 */
	const chatInstances = new Map<
		ConversationId,
		ReturnType<typeof createChat>
	>();

	/**
	 * Get or create a ChatClient for a conversation.
	 *
	 * Lazily creates instances on first access. The connection callback
	 * reads the conversation's provider/model at request time (not creation
	 * time) so provider/model changes take effect on the next send.
	 *
	 * @example
	 * ```typescript
	 * const chat = ensureChat('conv-123');
	 * chat.sendMessage({ content: 'Hello' });
	 * ```
	 */
	function ensureChat(
		conversationId: ConversationId,
	): ReturnType<typeof createChat> {
		const existing = chatInstances.get(conversationId);
		if (existing) return existing;

		const instance = createChat({
			initialMessages: loadMessagesForConversation(conversationId),
			tools: tabManagerClientTools,
			connection: fetchServerSentEvents(
				() => `${hubUrlCache}/ai/chat`,
				async () => {
					// Read conversation at request time for fresh provider/model
					const conv = conversations.find((c) => c.id === conversationId);
					return {
						body: {
							provider: conv?.provider ?? DEFAULT_PROVIDER,
							model: conv?.model ?? DEFAULT_MODEL,
							conversationId,
							systemPrompt: conv?.systemPrompt ?? TAB_MANAGER_SYSTEM_PROMPT,
							tools: allServerToolDefinitions,
						},
					};
				},
			),
			onFinish: (message) => {
				// conversationId is baked in — can never target the wrong conversation
				popupWorkspace.tables.chatMessages.set({
					id: message.id as string as ChatMessageId,
					conversationId,
					role: 'assistant',
					parts: message.parts,
					createdAt: message.createdAt?.getTime() ?? Date.now(),
					_v: 1,
				});
				// Touch conversation's updatedAt so it floats to top of list
				const conv = conversations.find((c) => c.id === conversationId);
				if (conv) {
					popupWorkspace.tables.conversations.set({
						...conv,
						updatedAt: Date.now(),
					});
				}
			},
		});

		chatInstances.set(conversationId, instance);
		return instance;
	}

	// ── Conversation CRUD ─────────────────────────────────────────────

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
		const id = generateId() as string as ConversationId;
		const now = Date.now();
		const current = getActiveConversation();

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
	 * Changes which conversation the getters read from. If the previous
	 * conversation was streaming, it continues in the background.
	 *
	 * For idle instances (not currently streaming), refreshes messages
	 * from Y.Doc to ensure the view reflects the latest persisted state
	 * (e.g., a response that completed in the background since the user
	 * last viewed this conversation).
	 */
	function switchConversation(conversationId: ConversationId) {
		activeConversationId = conversationId;

		// Refresh idle instances from Y.Doc so the view is always current.
		// Streaming instances keep their internal state (includes the
		// in-progress assistant message that Y.Doc doesn't have yet).
		const instance = chatInstances.get(conversationId);
		if (instance && !instance.isLoading) {
			instance.setMessages(loadMessagesForConversation(conversationId));
		}
	}

	/**
	 * Delete a conversation and all its messages.
	 *
	 * Uses a Y.Doc batch so the observer fires once (not N+1 times).
	 * Stops any active stream for the conversation and removes its
	 * ChatClient instance. If the deleted conversation was active,
	 * switches to the most recent remaining one (or creates a fresh one).
	 */
	function deleteConversation(conversationId: ConversationId) {
		// Stop and discard the ChatClient instance
		const instance = chatInstances.get(conversationId);
		if (instance) {
			instance.stop();
			chatInstances.delete(conversationId);
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

	/**
	 * Rename a conversation.
	 *
	 * Writes to Y.Doc — the observer propagates the change to the
	 * reactive `conversations` list and `activeConversation` derived.
	 */
	function renameConversation(conversationId: ConversationId, title: string) {
		const conv = conversations.find((c) => c.id === conversationId);
		if (!conv) return;

		popupWorkspace.tables.conversations.set({
			...conv,
			title,
			updatedAt: Date.now(),
		});
	}

	// ── Provider / Model (per-conversation) ───────────────────────────

	/**
	 * Update the active conversation's provider.
	 *
	 * Auto-selects the first model for the new provider so the user
	 * always has a valid model selected after switching providers.
	 */
	function setProvider(providerName: string) {
		const conv = getActiveConversation();
		const models = PROVIDER_MODELS[providerName as Provider];
		popupWorkspace.tables.conversations.set({
			...conv,
			provider: providerName,
			model: models?.[0] ?? conv.model,
			updatedAt: Date.now(),
		});
	}

	/** Update the active conversation's model. */
	function setModel(modelName: string) {
		const conv = getActiveConversation();
		popupWorkspace.tables.conversations.set({
			...conv,
			model: modelName,
			updatedAt: Date.now(),
		});
	}

	// ── Public API ────────────────────────────────────────────────────

	return {
		// ── Chat State (reactive via TanStack AI runes) ───────────────

		/**
		 * The current conversation's messages (reactive).
		 *
		 * Reads from the active conversation's ChatClient instance.
		 */
		get messages() {
			return ensureChat(activeConversationId).messages;
		},

		/**
		 * Whether a response is currently streaming for the active conversation.
		 *
		 * Only reflects the active conversation's state — other conversations
		 * may be streaming in the background without affecting this.
		 */
		get isLoading() {
			return ensureChat(activeConversationId).isLoading;
		},

		/**
		 * The latest error from the active conversation's stream, if any.
		 *
		 * Scoped to the active conversation — background stream errors
		 * don't leak into the current view.
		 */
		get error() {
			return ensureChat(activeConversationId).error;
		},

		/**
		 * Fine-grained connection status for the active conversation.
		 *
		 * More granular than `isLoading` — distinguishes between idle,
		 * streaming, and other states. Useful for nuanced UI indicators
		 * (e.g., "connecting..." vs "generating...").
		 */
		get status() {
			return ensureChat(activeConversationId).status;
		},

		// ── Conversation Management ───────────────────────────────────

		/** All conversations, sorted by most recently updated first (reactive). */
		get conversations() {
			return conversations;
		},

		/** The active conversation's ID (always valid). */
		get activeConversationId() {
			return activeConversationId;
		},

		/** The active conversation's full metadata (reactive). */
		get activeConversation() {
			return activeConversation;
		},

		createConversation,
		switchConversation,
		deleteConversation,
		renameConversation,

		// ── Provider / Model (per-conversation) ───────────────────────

		/** Current provider name (reads from active conversation). */
		get provider() {
			return activeConversation.provider;
		},
		set provider(value: string) {
			setProvider(value);
		},

		/** Current model name (reads from active conversation). */
		get model() {
			return activeConversation.model;
		},
		set model(value: string) {
			setModel(value);
		},

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

		// ── Chat Actions ──────────────────────────────────────────────

		/**
		 * Send a user message and begin streaming the assistant response.
		 *
		 * Renames the conversation to the first message's text if it's
		 * still the default "New Chat" title.
		 *
		 * Writes the user message to Y.Doc before sending, and persists
		 * the assistant response via `onFinish`.
		 */
		sendMessage(content: string) {
			if (!content.trim()) return;
			const convId = activeConversationId;
			const userMessageId = generateId() as string as ChatMessageId;
			popupWorkspace.tables.chatMessages.set({
				id: userMessageId,
				conversationId: convId,
				role: 'user',
				parts: [{ type: 'text', content }],
				createdAt: Date.now(),
				_v: 1,
			});

			// Touch updatedAt so this conversation floats to top,
			// and rename from default title on first message.
			const conv = getActiveConversation();
			popupWorkspace.tables.conversations.set({
				...conv,
				title: conv.title === 'New Chat' ? content.trim().slice(0, 50) : conv.title,
				updatedAt: Date.now(),
			});
			// Send via this conversation's ChatClient (triggers SSE streaming)
			void ensureChat(convId).sendMessage({ content, id: userMessageId });
		},

		/**
		 * Regenerate the last assistant message.
		 *
		 * Deletes the old assistant message from Y.Doc, then calls
		 * `reload()` which re-requests a response from the server.
		 * The new response is persisted via `onFinish`.
		 */
		reload() {
			const chat = ensureChat(activeConversationId);
			const lastMessage = chat.messages.at(-1);
			if (lastMessage?.role === 'assistant') {
				popupWorkspace.tables.chatMessages.delete(lastMessage.id as string as ChatMessageId);
			}
			void chat.reload();
		},

		/** Stop the active conversation's streaming response. */
		stop() {
			ensureChat(activeConversationId).stop();
		},

		/**
		 * Whether a specific conversation is currently streaming a response.
		 *
		 * Useful for showing background streaming indicators in the
		 * conversation list — e.g., a pulsing dot next to conversations
		 * that are generating responses while the user views another.
		 *
		 * Returns `false` for conversations that don't have a ChatClient
		 * instance (never opened or evicted from cache).
		 *
		 * @example
		 * ```svelte
		 * {#if aiChatState.isStreaming(conv.id)}
		 *   <span class="animate-pulse rounded-full bg-primary size-1.5" />
		 * {/if}
		 * ```
		 */
		isStreaming(conversationId: ConversationId): boolean {
			return chatInstances.get(conversationId)?.isLoading ?? false;
		},
	};
}

export const aiChatState = createAiChatState();

// ─────────────────────────────────────────────────────────────────────────────
// UIMessage Boundary (co-located from ui-message.ts)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compile-time drift detection for TanStack AI message types.
 *
 * The workspace schema stores message parts as `unknown[]` because:
 * 1. Parts are always produced by TanStack AI — never user-constructed
 * 2. Runtime validation of guaranteed-correct data wastes CPU
 * 3. Replicating 8 complex part types in arktype is fragile to upgrades
 *
 * Instead, we use compile-time assertions to catch drift when upgrading
 * TanStack AI. If the MessagePart shape changes, these assertions fail
 * and the build breaks — forcing us to update our understanding.
 *
 * @see https://tanstack.com/ai/latest — UIMessage / MessagePart types
 * @see https://www.totaltypescript.com/how-to-test-your-types#rolling-your-own — Expect / Equal
 */

// ── Type test utilities ───────────────────────────────────────────────
// Rolling-your-own type testing from Total TypeScript.
// @see https://www.totaltypescript.com/how-to-test-your-types#rolling-your-own

type Expect<T extends true> = T;
type Equal<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
		? true
		: false;

// ── Derive the actual MessagePart type from UIMessage ─────────────────
// This is the type that gets stored in Y.Doc via onFinish/sendMessage.

type TanStackMessagePart = UIMessage['parts'][number];

// ── Compile-time drift detection ──────────────────────────────────────
// If TanStack AI adds, removes, or renames a part type, TypeScript
// reports a type error here — forcing us to update our understanding.

type ExpectedPartTypes =
	| 'text'
	| 'image'
	| 'audio'
	| 'video'
	| 'document'
	| 'tool-call'
	| 'tool-result'
	| 'thinking';

type _DriftCheck = Expect<
	Equal<TanStackMessagePart['type'], ExpectedPartTypes>
>;

// ── Typed boundary: unknown[] → MessagePart[] ─────────────────────────

/**
 * Convert a persisted chat message to a TanStack AI UIMessage.
 *
 * This is the single boundary where `unknown[]` is cast to `MessagePart[]`.
 * Safe because parts are always produced by TanStack AI and round-tripped
 * through Y.Doc serialization (structuredClone-compatible, lossless for
 * plain objects).
 */
function toUiMessage(message: ChatMessage): UIMessage {
	return {
		id: message.id,
		role: message.role,
		parts: message.parts as TanStackMessagePart[],
		createdAt: new Date(message.createdAt),
	};
}
