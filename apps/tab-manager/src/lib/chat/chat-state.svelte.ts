/**
 * Reactive AI chat state with multi-conversation support.
 *
 * Architecture: self-contained ConversationHandles backed by `createChat`.
 *
 * Each ConversationHandle owns a `createChat` instance from `@tanstack/ai-svelte`
 * which manages reactive state internally via Svelte 5 runes and persists
 * message bodies to extension-local IndexedDB (see ./persistence.ts). Domain
 * logic (conversation metadata, title updates, tool approval) is layered on
 * top.
 *
 * Background streaming is free: each conversation has its own chat instance.
 * Switching away from a streaming conversation doesn't stop it.
 *
 * Components read this through `workspace.state.aiChat`.
 */

import type { AuthClient } from '@epicenter/auth';
import { AiChatHttpError } from '@epicenter/constants/ai-chat-errors';
import { APP_URLS } from '@epicenter/constants/vite';
import { createAiChatFetch, fromTable } from '@epicenter/svelte';
import { createChat, fetchServerSentEvents } from '@tanstack/ai-svelte';
import { SvelteMap } from 'svelte/reactivity';
import { chatPersistence } from '$lib/chat/persistence';
import {
	AVAILABLE_PROVIDERS,
	DEFAULT_MODEL,
	DEFAULT_PROVIDER,
	PROVIDER_MODELS,
	type Provider,
} from '$lib/chat/providers';
import {
	buildDeviceConstraints,
	TAB_MANAGER_SYSTEM_PROMPT,
} from '$lib/chat/system-prompt';
import type { SessionAiTools } from '$lib/session.svelte';
import type { TabManagerBrowser } from '$lib/tab-manager/extension';
import {
	asConversationId,
	type Conversation,
	type ConversationId,
	generateConversationId,
} from '$lib/workspace';

export function createAiChatState({
	auth,
	tabManager,
	sessionAiTools,
}: {
	auth: AuthClient;
	tabManager: TabManagerBrowser;
	sessionAiTools: SessionAiTools;
}) {
	// ── Conversation List (Y.Doc-backed) ──────────────────────────────

	const conversationsMap = fromTable(tabManager.tables.conversations);
	const conversations = $derived(
		[...conversationsMap.values()].sort((a, b) => b.updatedAt - a.updatedAt),
	);

	/**
	 * Ensure at least one conversation exists.
	 *
	 * Called after persistence loads. Safe to call multiple times because
	 * it only creates if truly empty.
	 */
	function ensureDefaultConversation(): ConversationId | undefined {
		if (conversations.length > 0) return undefined;
		const id = generateConversationId();
		const now = Date.now();
		tabManager.tables.conversations.set({
			id,
			title: 'New Chat',
			provider: DEFAULT_PROVIDER,
			model: DEFAULT_MODEL,
			createdAt: now,
			updatedAt: now,
		});
		return id;
	}

	// ── Helpers ───────────────────────────────────────────────────────

	/** Update a conversation's fields and touch `updatedAt`. */
	function updateConversation(
		conversationId: ConversationId,
		patch: Partial<Omit<Conversation, 'id'>>,
	) {
		tabManager.tables.conversations.update(conversationId, {
			...patch,
			updatedAt: Date.now(),
		});
	}

	// ── Handle Registry ──────────────────────────────────────────────

	/** Per-conversation handle projections used reactively in templates. */
	const handles = new SvelteMap<
		ConversationId,
		ReturnType<typeof createConversationHandle>
	>();

	// ── Conversation Handle Factory ──────────────────────────────────

	/**
	 * Create a self-contained reactive handle for a single conversation.
	 *
	 * Uses `createChat` from `@tanstack/ai-svelte` for reactive state
	 * management. Domain logic (conversation metadata, tool approval,
	 * title updates) is layered on top.
	 *
	 * The baked-in `conversationId` means getters and actions always target
	 * the correct conversation, even from async callbacks.
	 */
	function createConversationHandle(conversationId: ConversationId) {
		let inputValue = $state('');
		let dismissedError = $state<string | null>(null);

		const metadata = $derived(conversationsMap.get(conversationId));

		// Message bodies live in extension-local IndexedDB through the
		// persistence adapter, hydrated by conversation id; see
		// ./persistence.ts for why they left the Y.Doc. The client owns the
		// whole write path: sends, streamed chunks, and reload truncation all
		// land in storage through its ordered setItem queue.
		const chat = createChat({
			id: conversationId,
			persistence: chatPersistence,
			tools: sessionAiTools.tools,
			connection: fetchServerSentEvents(`${APP_URLS.API}/ai/chat`, async () => {
				const deviceId = tabManager.deviceId;
				return {
					fetchClient: createAiChatFetch(auth.fetch),
					body: {
						data: {
							provider: metadata?.provider ?? DEFAULT_PROVIDER,
							model: metadata?.model ?? DEFAULT_MODEL,
							systemPrompts: [
								buildDeviceConstraints(deviceId),
								TAB_MANAGER_SYSTEM_PROMPT,
							],
							tools: sessionAiTools.definitions,
						},
					},
				};
			}),
			onError: (err) => {
				console.error(
					'[ai-chat] stream error:',
					err.message,
					'conversation:',
					conversationId,
				);
			},
			onFinish: () => {
				// Touch updatedAt so the sidebar ordering tracks activity; the
				// persistence adapter already stored the assistant message.
				updateConversation(conversationId, {});
			},
		});

		return {
			// ── Identity ──

			get id() {
				return conversationId;
			},

			// ── Y.Doc-backed metadata (derived from conversations array) ──

			get title() {
				return metadata?.title ?? 'New Chat';
			},

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

			get model() {
				return metadata?.model ?? DEFAULT_MODEL;
			},
			set model(value: string) {
				updateConversation(conversationId, { model: value });
			},

			get createdAt() {
				return metadata?.createdAt ?? 0;
			},

			get updatedAt() {
				return metadata?.updatedAt ?? 0;
			},

			// ── Chat state (from createChat) ──

			get messages() {
				return chat.messages;
			},

			get isLoading() {
				return chat.isLoading;
			},

			get error() {
				return chat.error;
			},

			get status() {
				return chat.status;
			},

			/**
			 * Whether the last error was a 402 (credits exhausted).
			 * UI should show an upgrade prompt when true.
			 */
			get isCreditsExhausted() {
				return (
					chat.error instanceof AiChatHttpError &&
					chat.error.detail.name === 'InsufficientCredits'
				);
			},

			get isUnauthorized() {
				return (
					chat.error instanceof AiChatHttpError &&
					chat.error.detail.name === 'Unauthorized'
				);
			},

			get isModelRestricted() {
				return (
					chat.error instanceof AiChatHttpError &&
					chat.error.detail.name === 'ModelRequiresPaidPlan'
				);
			},

			// ── Ephemeral UI state ──

			get inputValue() {
				return inputValue;
			},
			set inputValue(value: string) {
				inputValue = value;
			},

			get dismissedError() {
				return dismissedError;
			},
			set dismissedError(value: string | null) {
				dismissedError = value;
			},

			// ── Derived convenience ──

			get lastMessagePreview() {
				// Every handle's chat hydrates from IndexedDB at creation, so
				// the live message list is the preview source for all
				// conversations, not just the active one.
				const last = chat.messages.at(-1);
				if (!last) return '';
				const text = last.parts
					.filter((p) => p.type === 'text')
					.map((p) => p.content)
					.join('')
					.trim();
				return text.length > 60 ? `${text.slice(0, 60)}…` : text;
			},

			// ── Actions ──

			sendMessage(content: string) {
				if (!content.trim()) return;
				void chat.sendMessage(content);

				updateConversation(conversationId, {
					title:
						metadata?.title === 'New Chat'
							? content.trim().slice(0, 50)
							: metadata?.title,
				});
			},

			reload() {
				// The client truncates past the last user message and the
				// persistence adapter stores the truncated list.
				void chat.reload();
			},

			stop() {
				chat.stop();
			},

			/**
			 * Tear down the chat client: abort any in-flight stream, then
			 * release the devtools bridge, which holds the client in a
			 * globalThis registry that would otherwise outlive the handle.
			 */
			dispose() {
				chat.stop();
				chat.dispose();
			},

			/**
			 * Delete this conversation's stored history through the client's
			 * ordered persistence queue (`clear` invalidates queued writes),
			 * so a mid-stream setItem can't land after the delete and
			 * resurrect history the user asked to remove. Calling the
			 * adapter's removeItem directly would race that queue.
			 */
			clearHistory() {
				chat.clear();
			},

			approveToolCall(approvalId: string) {
				void chat.addToolApprovalResponse({ id: approvalId, approved: true });
			},

			denyToolCall(approvalId: string) {
				void chat.addToolApprovalResponse({ id: approvalId, approved: false });
			},

			rename(title: string) {
				updateConversation(conversationId, { title });
			},

			delete() {
				deleteConversation(conversationId);
			},
		};
	}

	// ── Lifecycle ────────────────────────────────────────────────────

	/** Dispose the chat client and remove the handle for a conversation. */
	function destroyConversation(id: ConversationId) {
		handles.get(id)?.dispose();
		handles.delete(id);
	}

	/**
	 * Sync handles with the conversationsMap.
	 *
	 * Creates handles for new conversation IDs, destroys handles
	 * for deleted IDs. Existing handles survive, so their chat instance
	 * and ephemeral state persist.
	 */
	function reconcileHandles() {
		for (const id of handles.keys()) {
			if (!conversationsMap.has(id as string)) {
				destroyConversation(id);
			}
		}

		for (const id of conversationsMap.keys()) {
			const convId = asConversationId(id);
			if (!handles.has(convId)) {
				handles.set(convId, createConversationHandle(convId));
			}
		}
	}

	// ── Active Conversation ──────────────────────────────────────────

	let activeConversationId = $state<ConversationId>(asConversationId(''));

	// ── Observers ────────────────────────────────────────────────────────────

	const _unobserveConversations = tabManager.tables.conversations.observe(
		() => {
			reconcileHandles();
		},
	);

	// Initialize after persistence loads
	void tabManager.idb.whenLoaded.then(() => {
		reconcileHandles();
		const newId = ensureDefaultConversation();
		const [firstConversation] = conversations;
		if (firstConversation) {
			activeConversationId = newId ?? firstConversation.id;
		}
	});

	reconcileHandles();

	// ── Conversation CRUD ────────────────────────────────────────────

	function createConversation(): ConversationId {
		const id = generateConversationId();
		const now = Date.now();
		const current = handles.get(activeConversationId);

		tabManager.tables.conversations.set({
			id,
			title: 'New Chat',
			provider: current?.provider ?? DEFAULT_PROVIDER,
			model: current?.model ?? DEFAULT_MODEL,
			createdAt: now,
			updatedAt: now,
		});

		activeConversationId = id;
		return id;
	}

	function deleteConversation(conversationId: ConversationId) {
		handles.get(conversationId)?.clearHistory();
		destroyConversation(conversationId);

		tabManager.tables.conversations.delete(conversationId);

		if (activeConversationId === conversationId) {
			const remaining = tabManager.tables.conversations
				.getAllValid()
				.sort((a, b) => b.updatedAt - a.updatedAt);
			const first = remaining[0];
			if (first) {
				activeConversationId = first.id;
			} else {
				createConversation();
			}
		}
	}

	// ── Public API ────────────────────────────────────────────────────

	const conversationList = $derived(
		conversations
			.map((c) => handles.get(c.id))
			.filter(
				(h): h is ReturnType<typeof createConversationHandle> =>
					h !== undefined,
			),
	);

	return {
		[Symbol.dispose]() {
			_unobserveConversations();
			conversationsMap[Symbol.dispose]();
			for (const id of handles.keys()) {
				destroyConversation(id);
			}
		},

		get active() {
			return handles.get(activeConversationId);
		},

		get conversations() {
			return conversationList;
		},

		get(id: ConversationId) {
			return handles.get(id);
		},

		get activeConversationId() {
			return activeConversationId;
		},

		createConversation,

		switchTo(conversationId: ConversationId) {
			activeConversationId = conversationId;
		},

		availableProviders: AVAILABLE_PROVIDERS,

		modelsForProvider(providerName: string): readonly string[] {
			return PROVIDER_MODELS[providerName as Provider] ?? [];
		},

		/** URL to the billing page for credit upgrades. */
		billingUrl: `${APP_URLS.API}/billing`,
	};
}

/** A reactive handle for a single conversation backed by `createChat`. */
type AiChatState = ReturnType<typeof createAiChatState>;
export type ConversationHandle = NonNullable<ReturnType<AiChatState['get']>>;
