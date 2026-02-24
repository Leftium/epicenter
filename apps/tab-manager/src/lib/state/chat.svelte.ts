/**
 * Reactive AI chat state with multi-conversation support.
 *
 * Chat runs in the background service worker (BGSW) — the side panel is
 * pure UI. Messages flow through Y.Doc:
 * 1. User types → side panel writes user message to Y.Doc
 * 2. Side panel sends `chrome.runtime.sendMessage({ type: 'chat' })` to BGSW
 * 3. BGSW runs `chat()` with tools, writes assistant messages progressively to Y.Doc
 * 4. BroadcastChannel syncs Y.Doc to side panel (sub-ms)
 * 5. Side panel's Y.Doc observer re-reads messages → reactive UI update
 *
 * Background streaming is free: BGSW continues running `chat()` even when
 * the side panel is closed or the user switches conversations. Completed
 * responses appear in Y.Doc and are visible on next open/switch.
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
import type { ChatRequest, ChatResponse } from '$lib/ai/engine';
import { getHubServerUrl } from '$lib/state/settings';
import type {
	ChatMessage,
	ChatMessageId,
	Conversation,
	ConversationId,
} from '$lib/workspace';
import { popupWorkspace } from '$lib/workspace-popup';

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

	// ── Active Conversation ───────────────────────────────────────────

	/** Initialize to the most recent conversation, or null if none exist. */
	let activeConversationId = $state<ConversationId | null>(
		conversations[0]?.id ?? null,
	);

	/**
	 * Derived from `activeConversationId` + `conversations`.
	 *
	 * Re-evaluates when either changes — e.g. when provider/model is
	 * updated in the table, the observer fires, `conversations` updates,
	 * and this re-derives with the new metadata.
	 */
	const activeConversation = $derived(
		conversations.find((c) => c.id === activeConversationId) ?? null,
	);

	// ── Messages (Y.Doc-backed, reactive) ────────────────────────────

	/** Load persisted messages for a conversation from Y.Doc. */
	const loadMessagesForConversation = (conversationId: ConversationId) =>
		popupWorkspace.tables.chatMessages
			.filter((m) => m.conversationId === conversationId)
			.sort((a, b) => a.createdAt - b.createdAt)
			.map(toUiMessage);

	/**
	 * Messages for the active conversation (reactive).
	 *
	 * Re-read from Y.Doc on every chatMessages observer fire. The BGSW
	 * writes assistant messages progressively to Y.Doc — BroadcastChannel
	 * syncs them here in sub-ms, triggering the observer, which re-reads.
	 */
	let activeMessages = $state<UIMessage[]>(
		activeConversationId
			? loadMessagesForConversation(activeConversationId)
			: [],
	);

	// Re-read messages whenever Y.Doc chatMessages change (progressive writes from BGSW).
	popupWorkspace.tables.chatMessages.observe(() => {
		if (!activeConversationId) return;
		activeMessages = loadMessagesForConversation(activeConversationId);
	});

	// ── Per-Conversation Streaming State ──────────────────────────────

	/**
	 * Lightweight streaming state per conversation.
	 *
	 * Replaces the heavy `createChat()` instances. The BGSW owns the
	 * actual chat lifecycle — the side panel only needs to know:
	 * - Is a request in-flight? (isLoading)
	 * - Did it error? (error message)
	 */
	const streamingState = new Map<
		ConversationId,
		{ isLoading: boolean; error: string | null }
	>();

	/**
	 * Get streaming state for a conversation, creating a default if needed.
	 * Not reactive — used internally. The reactive getters read from $state.
	 */
	function getStreamingState(conversationId: ConversationId) {
		let state = streamingState.get(conversationId);
		if (!state) {
			state = { isLoading: false, error: null };
			streamingState.set(conversationId, state);
		}
		return state;
	}

	/** Reactive streaming state for the active conversation. */
	let activeIsLoading = $state(false);
	let activeError = $state<string | null>(null);

	// ── Helpers ───────────────────────────────────────────────────────

	/**
	 * Get the active conversation by reading `$state` directly.
	 *
	 * Used in non-reactive contexts (async callbacks, event handlers)
	 * where `$derived` tracking isn't needed.
	 */
	const getActiveConversation = (): Conversation | null =>
		conversations.find((c) => c.id === activeConversationId) ?? null;

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
		sourceMessageId?: string;
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
	 * Changes which conversation the getters read from. Re-reads
	 * messages from Y.Doc and syncs the reactive streaming state.
	 */
	function switchConversation(conversationId: ConversationId) {
		activeConversationId = conversationId;

		// Re-read messages from Y.Doc for the newly active conversation
		activeMessages = loadMessagesForConversation(conversationId);

		// Sync reactive streaming state from the per-conversation map
		const state = getStreamingState(conversationId);
		activeIsLoading = state.isLoading;
		activeError = state.error;
	}

	/**
	 * Delete a conversation and all its messages.
	 *
	 * Uses a Y.Doc batch so the observer fires once (not N+1 times).
	 * Cleans up streaming state. If the deleted conversation was active,
	 * switches to the most recent remaining one.
	 */
	function deleteConversation(conversationId: ConversationId) {
		// Clean up streaming state
		streamingState.delete(conversationId);

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
				activeConversationId = null;
				activeMessages = [];
				activeIsLoading = false;
				activeError = null;
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
		if (!conv) return;

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
		if (!conv) return;

		popupWorkspace.tables.conversations.set({
			...conv,
			model: modelName,
			updatedAt: Date.now(),
		});
	}

	// ── BGSW Chat Request ────────────────────────────────────────────

	/**
	 * Send a chat request to the BGSW via `chrome.runtime.sendMessage`.
	 *
	 * The BGSW runs `chat()` with tools and writes assistant messages
	 * progressively to Y.Doc. The side panel observes these writes
	 * via BroadcastChannel for real-time streaming updates.
	 */
	async function sendChatToBgsw(
		conversationId: ConversationId,
		messages: UIMessage[],
	) {
		const conv = conversations.find((c) => c.id === conversationId);
		const hubServerUrl = await getHubServerUrl();

		const request: ChatRequest = {
			type: 'chat',
			conversationId,
			messages: messages.map((m) => ({
				id: m.id,
				role: m.role,
				parts: m.parts,
				createdAt: m.createdAt?.getTime() ?? Date.now(),
			})),
			provider: conv?.provider ?? DEFAULT_PROVIDER,
			model: conv?.model ?? DEFAULT_MODEL,
			systemPrompt: conv?.systemPrompt ?? undefined,
			hubServerUrl,
		};

		// Update streaming state
		const state = getStreamingState(conversationId);
		state.isLoading = true;
		state.error = null;

		// Sync reactive state if this is the active conversation
		if (conversationId === activeConversationId) {
			activeIsLoading = true;
			activeError = null;
		}

		try {
			const response: ChatResponse = await browser.runtime.sendMessage(request);

			if (response.type === 'error') {
				state.error = response.message;
				if (conversationId === activeConversationId) {
					activeError = response.message;
				}
			}
		} catch (error) {
			const message =
				error instanceof Error ? error.message : 'Failed to send chat request';
			state.error = message;
			if (conversationId === activeConversationId) {
				activeError = message;
			}
		} finally {
			state.isLoading = false;
			if (conversationId === activeConversationId) {
				activeIsLoading = false;
			}
		}
	}

	// ── Public API ────────────────────────────────────────────────────

	return {
		// ── Chat State (reactive via Y.Doc observers) ─────────────────

		/**
		 * The current conversation's messages (reactive).
		 *
		 * Read from Y.Doc via table observers. The BGSW writes assistant
		 * messages progressively — BroadcastChannel syncs them here in
		 * sub-ms, triggering the observer, which re-reads into this state.
		 */
		get messages() {
			return activeMessages;
		},

		/**
		 * Whether a response is currently streaming for the active conversation.
		 *
		 * Only reflects the active conversation's state — other conversations
		 * may be streaming in the background without affecting this.
		 */
		get isLoading() {
			return activeIsLoading;
		},

		/**
		 * The latest error from the active conversation's chat request, if any.
		 *
		 * Scoped to the active conversation — background chat errors
		 * don't leak into the current view.
		 */
		get error() {
			return activeError;
		},

		/**
		 * Connection status for the active conversation.
		 *
		 * Simplified from the TanStack AI granular status — now just
		 * 'ready' or 'streaming' based on whether a request is in-flight.
		 */
		get status() {
			return activeIsLoading ? ('streaming' as const) : ('ready' as const);
		},

		// ── Conversation Management ───────────────────────────────────

		/** All conversations, sorted by most recently updated first (reactive). */
		get conversations() {
			return conversations;
		},

		/** The active conversation's ID, or null if none. */
		get activeConversationId() {
			return activeConversationId;
		},

		/** The active conversation's full metadata, or null if none (reactive). */
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
			return activeConversation?.provider ?? DEFAULT_PROVIDER;
		},
		set provider(value: string) {
			setProvider(value);
		},

		/** Current model name (reads from active conversation). */
		get model() {
			return activeConversation?.model ?? DEFAULT_MODEL;
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
		 * If no conversation is active, one is auto-created with the
		 * message text as its title (truncated to 50 characters).
		 *
		 * Writes the user message to Y.Doc, then sends a chat request
		 * to the BGSW via `chrome.runtime.sendMessage`. The BGSW runs
		 * `chat()` with tools and writes assistant messages progressively
		 * to Y.Doc. The side panel observes these writes via BroadcastChannel.
		 */
		sendMessage(content: string) {
			if (!content.trim()) return;

			// Auto-create conversation if none active
			let convId = activeConversationId;
			if (!convId) {
				convId = createConversation({
					title: content.trim().slice(0, 50),
				});
			}

			const userMessageId = generateId() as string as ChatMessageId;

			// Write user message to Y.Doc
			popupWorkspace.tables.chatMessages.set({
				id: userMessageId,
				conversationId: convId,
				role: 'user',
				parts: [{ type: 'text', content }],
				createdAt: Date.now(),
				_v: 1,
			});

			// Touch updatedAt so this conversation floats to top
			const conv = getActiveConversation();
			if (conv) {
				popupWorkspace.tables.conversations.set({
					...conv,
					updatedAt: Date.now(),
				});
			}

			// Re-read messages to include the new user message, then send to BGSW
			const currentMessages = loadMessagesForConversation(convId);
			void sendChatToBgsw(convId, currentMessages);
		},

		/**
		 * Regenerate the last assistant message.
		 *
		 * Deletes the old assistant message from Y.Doc, then sends
		 * the remaining messages to the BGSW for a fresh response.
		 */
		reload() {
			if (!activeConversationId) return;

			const messages = loadMessagesForConversation(activeConversationId);
			const lastMessage = messages.at(-1);
			if (lastMessage?.role === 'assistant') {
				popupWorkspace.tables.chatMessages.delete(
					lastMessage.id as string as ChatMessageId,
				);
			}

			// Re-read messages after deletion and send to BGSW
			const remainingMessages =
				loadMessagesForConversation(activeConversationId);
			void sendChatToBgsw(activeConversationId, remainingMessages);
		},

		/**
		 * Stop the active conversation's streaming response.
		 *
		 * Note: Currently a no-op for the local streaming state. The BGSW
		 * does not support stream cancellation yet — the response will
		 * complete in the background and appear in Y.Doc.
		 *
		 * TODO: Implement stream cancellation via chrome.runtime.sendMessage({ type: 'chat:stop' })
		 */
		stop() {
			if (!activeConversationId) return;

			const state = getStreamingState(activeConversationId);
			state.isLoading = false;
			activeIsLoading = false;
		},

		/**
		 * Whether a specific conversation is currently streaming a response.
		 *
		 * Useful for showing background streaming indicators in the
		 * conversation list — e.g., a pulsing dot next to conversations
		 * that are generating responses while the user views another.
		 *
		 * @example
		 * ```svelte
		 * {#if aiChatState.isStreaming(conv.id)}
		 *   <span class="animate-pulse rounded-full bg-primary size-1.5" />
		 * {/if}
		 * ```
		 */
		isStreaming(conversationId: ConversationId): boolean {
			return streamingState.get(conversationId)?.isLoading ?? false;
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
