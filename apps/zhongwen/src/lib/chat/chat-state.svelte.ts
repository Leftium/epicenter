/**
 * Reactive AI chat state for Zhongwen with workspace persistence.
 *
 * Conversations and messages persist to IndexedDB via the workspace API.
 * Modeled after tab-manager's chat-state but simplified — no tool calls,
 * no encryption, no WebSocket sync.
 */

import { createChat, fetchServerSentEvents } from '@tanstack/ai-svelte';
import { APP_URLS } from '@epicenter/constants/vite';
import { SvelteMap } from 'svelte/reactivity';
import type { JsonValue } from 'wellcrafted/json';
import { authState } from '$lib/auth';
import {
	DEFAULT_MODEL,
	DEFAULT_PROVIDER,
	PROVIDER_MODELS,
	type Provider,
} from '$lib/chat/providers';
import { ZHONGWEN_SYSTEM_PROMPT } from '$lib/chat/system-prompt';
import { toUiMessage } from '$lib/chat/ui-message';
import { workspace } from '$lib/workspace/client';
import {
	type ChatMessageId,
	type Conversation,
	type ConversationId,
	generateChatMessageId,
	generateConversationId,
} from '$lib/workspace/schema';

// ─── State Factory ───────────────────────────────────────────────────────────

function createChatState() {
	// ── Conversation List (Y.Doc-backed) ──

	let conversationsVersion = $state(0);
	const conversations = $derived.by(() => {
		conversationsVersion; // subscribe to observer-driven changes
		return workspace.tables.conversations
			.getAllValid()
			.sort((a, b) => b.updatedAt - a.updatedAt);
	});

	function ensureDefaultConversation(): ConversationId | undefined {
		if (conversations.length > 0) return undefined;
		const id = generateConversationId();
		const now = Date.now();
		workspace.tables.conversations.set({
			id,
			title: 'New Chat',
			provider: DEFAULT_PROVIDER,
			model: DEFAULT_MODEL,
			createdAt: now,
			updatedAt: now,
			_v: 1,
		});
		conversationsVersion++;
		return id;
	}

	// ── Helpers ──

	function updateConversation(
		conversationId: ConversationId,
		patch: Partial<Omit<Conversation, 'id'>>,
	) {
		workspace.tables.conversations.update(conversationId, {
			...patch,
			updatedAt: Date.now(),
		});
	}

	function loadMessages(conversationId: ConversationId) {
		return workspace.tables.chatMessages
			.filter((m) => m.conversationId === conversationId)
			.sort((a, b) => a.createdAt - b.createdAt)
			.map(toUiMessage);
	}

	// ── Handle Registry ──

	let activeConversationId = $state<ConversationId>('' as ConversationId);

	const handles = new SvelteMap<
		ConversationId,
		ReturnType<typeof createConversationHandle>
	>();

	/** Internal lifecycle — refresh syncs workspace messages into the TanStack chat instance. */
	const refreshFns = new Map<ConversationId, () => void>();

	// ── Conversation Handle Factory ──

	function createConversationHandle(conversationId: ConversationId) {
		let inputValue = $state('');

		const metadata = $derived(
			conversations.find((c) => c.id === conversationId),
		);

		const chat = createChat({
			initialMessages: loadMessages(conversationId),
			connection: fetchServerSentEvents(
				() => `${APP_URLS.API}/ai/chat`,
				() => ({
					fetchClient: authState.fetch,
					body: {
						data: {
							provider: metadata?.provider ?? DEFAULT_PROVIDER,
							model: metadata?.model ?? DEFAULT_MODEL,
							systemPrompts: [ZHONGWEN_SYSTEM_PROMPT],
						},
					},
				}),
			),
			onError: (err) => {
				console.error(
					'[zhongwen] stream error:',
					err.message,
					'conversation:',
					conversationId,
				);
			},
			onFinish: (message) => {
				workspace.tables.chatMessages.set({
					id: message.id as string as ChatMessageId,
					conversationId,
					role: 'assistant',
					parts: message.parts as JsonValue[],
					createdAt: message.createdAt?.getTime() ?? Date.now(),
					_v: 1,
				});
				workspace.tables.conversations.update(conversationId, {
					updatedAt: Date.now(),
				});
			},
		});

		refreshFns.set(conversationId, () => {
			if (chat.isLoading) return;
			chat.setMessages(loadMessages(conversationId));
		});

		return {
			get id() {
				return conversationId;
			},

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

			get messages() {
				return chat.messages;
			},

			get isLoading() {
				return chat.isLoading;
			},

			get error() {
				return chat.error;
			},

			get inputValue() {
				return inputValue;
			},
			set inputValue(value: string) {
				inputValue = value;
			},

			sendMessage(content: string) {
				if (!content.trim()) return;
				const userMessageId = generateChatMessageId();

				// Send to client FIRST so isLoading=true before the
				// observer fires refreshFromDoc (which skips when loading).
				void chat.sendMessage({ content, id: userMessageId });

				workspace.tables.chatMessages.set({
					id: userMessageId,
					conversationId,
					role: 'user',
					parts: [{ type: 'text', content }],
					createdAt: Date.now(),
					_v: 1,
				});

				updateConversation(conversationId, {
					title:
						metadata?.title === 'New Chat'
							? content.trim().slice(0, 50)
							: metadata?.title,
				});
			},

			reload() {
				const lastMessage = chat.messages.at(-1);
				if (lastMessage?.role === 'assistant') {
					workspace.tables.chatMessages.delete(
						lastMessage.id as string as ChatMessageId,
					);
				}
				void chat.reload();
			},

			stop() {
				chat.stop();
			},
		};
	}

	// ── Lifecycle ──

	function destroyConversation(id: ConversationId) {
		handles.get(id)?.stop();
		refreshFns.delete(id);
		handles.delete(id);
	}

	function reconcileHandles() {
		const currentIds = new Set(conversations.map((c) => c.id));

		for (const id of handles.keys()) {
			if (!currentIds.has(id)) {
				destroyConversation(id);
			}
		}

		for (const conv of conversations) {
			if (!handles.has(conv.id)) {
				handles.set(conv.id, createConversationHandle(conv.id));
			}
		}
	}

	// ── Observers ──

	workspace.tables.conversations.observe(() => {
		conversationsVersion++;
		reconcileHandles();
	});
	workspace.tables.chatMessages.observe(() => {
		refreshFns.get(activeConversationId)?.();
	});

	// Initialize after persistence loads
	void workspace.whenReady.then(() => {
		conversationsVersion++;
		reconcileHandles();
		const newId = ensureDefaultConversation();
		const first = conversations[0];
		if (first) {
			activeConversationId = newId ?? first.id;
		}
	});

	reconcileHandles();

	// ── Conversation CRUD ──

	function createConversation(): ConversationId {
		const id = generateConversationId();
		const now = Date.now();
		const current = handles.get(activeConversationId);

		workspace.tables.conversations.set({
			id,
			title: 'New Chat',
			provider: current?.provider ?? DEFAULT_PROVIDER,
			model: current?.model ?? DEFAULT_MODEL,
			createdAt: now,
			updatedAt: now,
			_v: 1,
		});

		switchConversation(id);
		return id;
	}

	function switchConversation(conversationId: ConversationId) {
		activeConversationId = conversationId;
		refreshFns.get(conversationId)?.();
	}

	function deleteConversation(conversationId: ConversationId) {
		destroyConversation(conversationId);

		const msgs = workspace.tables.chatMessages
			.getAllValid()
			.filter((m) => m.conversationId === conversationId);
		workspace.batch(() => {
			for (const m of msgs) {
				workspace.tables.chatMessages.delete(m.id);
			}
			workspace.tables.conversations.delete(conversationId);
		});

		if (activeConversationId === conversationId) {
			const first = workspace.tables.conversations
				.getAllValid()
				.sort((a, b) => b.updatedAt - a.updatedAt)[0];
			if (first) {
				switchConversation(first.id);
			} else {
				createConversation();
			}
		}
	}

	// ── Public API ──

	const conversationList = $derived(
		conversations
			.map((c) => handles.get(c.id))
			.filter((h) => h !== undefined),
	);

	return {
		get active() {
			return handles.get(activeConversationId);
		},

		get conversationHandles() {
			return conversationList;
		},

		get activeConversationId() {
			return activeConversationId;
		},

		createConversation,

		switchTo: switchConversation,

		deleteConversation,
	};
}

export const chatState = createChatState();

export type ConversationHandle = NonNullable<(typeof chatState)['active']>;
