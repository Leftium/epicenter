/**
 * Reactive AI chat state for Zhongwen.
 *
 * Simplified from tab-manager's chat-state — no Y.Doc, no tool calls.
 * Conversations are in-memory with messages persisted to localStorage.
 */

import {
	ChatClient,
	fetchServerSentEvents,
	type ChatClientState,
	type UIMessage,
} from '@tanstack/ai-client';
import { APP_URLS } from '@epicenter/constants/vite';
import { SvelteMap } from 'svelte/reactivity';
import { authState } from '$lib/auth';
import {
	DEFAULT_MODEL,
	DEFAULT_PROVIDER,
	PROVIDER_MODELS,
	type Provider,
} from '$lib/chat/providers';
import { ZHONGWEN_SYSTEM_PROMPT } from '$lib/chat/system-prompt';


// ─── Types ───────────────────────────────────────────────────────────────────

type ConversationId = string & { __brand: 'ConversationId' };

type Conversation = {
	id: ConversationId;
	title: string;
	provider: string;
	model: string;
	createdAt: number;
	updatedAt: number;
};

// ─── ID Generation ───────────────────────────────────────────────────────────

let idCounter = 0;
function generateId(): ConversationId {
	return `conv_${Date.now()}_${++idCounter}` as ConversationId;
}

function generateMessageId(): string {
	return `msg_${Date.now()}_${++idCounter}`;
}

// ─── State Factory ───────────────────────────────────────────────────────────

function createChatState() {
	let conversations = $state<Conversation[]>([]);
	let activeConversationId = $state<ConversationId>('' as ConversationId);

	const handles = new SvelteMap<
		ConversationId,
		ReturnType<typeof createConversationHandle>
	>();

	// ── Conversation Handle Factory ──

	const SUBMITTED_TIMEOUT_MS = 60_000;

	function createConversationHandle(conversationId: ConversationId) {
		let messages = $state<UIMessage[]>([]);
		let status = $state<ChatClientState>('ready');
		let isLoading = $state(false);
		let error = $state<Error | undefined>(undefined);
		let inputValue = $state('');
		let submittedTimer: ReturnType<typeof setTimeout> | undefined;

		const metadata = $derived(
			conversations.find((c) => c.id === conversationId),
		);

		const client = new ChatClient({
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
			onMessagesChange: (msgs) => {
				messages = [...msgs];
			},
			onLoadingChange: (loading) => {
				isLoading = loading;
			},
			onErrorChange: (err) => {
				error = err;
				if (err && /401|unauthorized/i.test(err.message)) {
					authState.checkSession();
				}
			},
			onStatusChange: (newStatus) => {
				status = newStatus;
				messages = [...client.getMessages()];

				if (submittedTimer) {
					clearTimeout(submittedTimer);
					submittedTimer = undefined;
				}

				if (newStatus === 'submitted') {
					submittedTimer = setTimeout(() => {
						submittedTimer = undefined;
						if (status !== 'submitted') return;
						console.warn('[zhongwen] timeout: no response within 60s', conversationId);
						client.stop();
						error = new Error('Request timed out. The AI did not respond within 60 seconds.');
						status = 'error';
						isLoading = false;
					}, SUBMITTED_TIMEOUT_MS);
				}
			},
			onError: (err) => {
				console.error('[zhongwen] stream error:', err.message, 'conversation:', conversationId);
			},
			onFinish: () => {
				if (metadata) metadata.updatedAt = Date.now();
			},
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
				if (!metadata || !(value in PROVIDER_MODELS)) return;
				metadata.provider = value;
				metadata.model = PROVIDER_MODELS[value as Provider][0] ?? DEFAULT_MODEL;
			},

			get model() {
				return metadata?.model ?? DEFAULT_MODEL;
			},
			set model(value: string) {
				if (metadata) metadata.model = value;
			},

			get messages() {
				return messages;
			},

			get status() {
				return status;
			},

			get isLoading() {
				return isLoading;
			},

			get error() {
				return error;
			},

			get inputValue() {
				return inputValue;
			},
			set inputValue(value: string) {
				inputValue = value;
			},

			sendMessage(content: string) {
				if (!content.trim()) return;
				void client.sendMessage({ content, id: generateMessageId() });
				if (metadata && metadata.title === 'New Chat') {
					metadata.title = content.trim().slice(0, 50);
				}
			},

			reload() {
				void client.reload();
			},

			stop() {
				client.stop();
			},

			rename(title: string) {
				if (metadata) metadata.title = title;
			},

			destroy() {
				if (submittedTimer) clearTimeout(submittedTimer);
				client.stop();
			},
		};
	}

	// ── Lifecycle ──

	function createConversation(): ConversationId {
		const id = generateId();
		const now = Date.now();
		const current = handles.get(activeConversationId);

		conversations = [
			{
				id,
				title: 'New Chat',
				provider: current?.provider ?? DEFAULT_PROVIDER,
				model: current?.model ?? DEFAULT_MODEL,
				createdAt: now,
				updatedAt: now,
			},
			...conversations,
		];

		handles.set(id, createConversationHandle(id));
		activeConversationId = id;
		return id;
	}

	function deleteConversation(conversationId: ConversationId) {
		handles.get(conversationId)?.destroy();
		handles.delete(conversationId);
		conversations = conversations.filter((c) => c.id !== conversationId);

		if (activeConversationId === conversationId) {
			const first = conversations[0];
			if (first) {
				activeConversationId = first.id;
			} else {
				createConversation();
			}
		}
	}

	// Initialize with one conversation
	createConversation();

	// ── Public API ──

	return {
		get active() {
			return handles.get(activeConversationId);
		},

		get conversationHandles() {
			return conversations
				.map((c) => handles.get(c.id))
				.filter((h) => h !== undefined);
		},

		get activeConversationId() {
			return activeConversationId;
		},

		createConversation,

		switchTo(conversationId: ConversationId) {
			activeConversationId = conversationId;
		},

		deleteConversation,
	};
}

export const chatState = createChatState();

export type ConversationHandle = NonNullable<(typeof chatState)['active']>;
