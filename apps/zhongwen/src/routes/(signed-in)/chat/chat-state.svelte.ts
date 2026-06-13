/**
 * Conversation list + selection state for Zhongwen chat.
 *
 * This factory owns only the durable, root-doc concerns: the conversation
 * list (the `conversations` table), which conversation is active, and the
 * provider/model selection for the active row. The per-conversation runtime
 * (transcript doc, streaming, liveness, send/stop) lives in
 * `ConversationView.svelte`, mounted via `{#key activeConversationId}` so the
 * doc handle gets a real component lifecycle instead of imperative
 * `$state`-in-a-callback.
 */

import { fromTable } from '@epicenter/svelte';
import {
	type Conversation,
	type ConversationId,
	generateConversationId,
} from '@epicenter/zhongwen';
import { requireZhongwen } from '$lib/session';
import {
	DEFAULT_MODEL,
	DEFAULT_PROVIDER,
	PROVIDER_MODELS,
	type Provider,
} from './providers';

export function createChatState() {
	const zhongwen = requireZhongwen();

	const conversationsMap = fromTable(zhongwen.tables.conversations);
	const conversations = $derived(
		[...conversationsMap.values()].sort((a, b) => b.updatedAt - a.updatedAt),
	);

	let activeConversationId = $state<ConversationId | undefined>();
	const active = $derived(
		activeConversationId
			? conversationsMap.get(activeConversationId)
			: undefined,
	);

	/** Returns the ID to activate, either the first existing conversation or a newly created default. */
	function ensureDefaultConversation(): ConversationId {
		const first = conversations[0];
		if (first) return first.id;

		const id = generateConversationId();
		const timestamp = Date.now();
		zhongwen.tables.conversations.set({
			id,
			title: 'New Chat',
			provider: DEFAULT_PROVIDER,
			model: DEFAULT_MODEL,
			createdAt: timestamp,
			updatedAt: timestamp,
		});
		return id;
	}

	function updateConversation(
		conversationId: ConversationId,
		patch: Partial<Omit<Conversation, 'id'>>,
	) {
		zhongwen.tables.conversations.update(conversationId, {
			...patch,
			updatedAt: Date.now(),
		});
	}

	// Fall back to the default conversation if the active row disappears
	// (deleted here or on another device).
	const unobserve = zhongwen.tables.conversations.observe(() => {
		if (activeConversationId && !conversationsMap.has(activeConversationId)) {
			activeConversationId = ensureDefaultConversation();
		}
	});

	void zhongwen.idb.whenLoaded.then(() => {
		activeConversationId ??= ensureDefaultConversation();
	});

	return {
		get conversations() {
			return conversations;
		},

		get activeConversationId() {
			return activeConversationId;
		},

		/** The active conversation row: title and the durable provider/model the header reads. */
		get active() {
			return active;
		},

		createConversation(): ConversationId {
			const id = generateConversationId();
			const timestamp = Date.now();
			zhongwen.tables.conversations.set({
				id,
				title: 'New Chat',
				provider: active?.provider ?? DEFAULT_PROVIDER,
				model: active?.model ?? DEFAULT_MODEL,
				createdAt: timestamp,
				updatedAt: timestamp,
			});
			activeConversationId = id;
			return id;
		},

		switchTo(conversationId: ConversationId) {
			activeConversationId = conversationId;
		},

		deleteConversation(conversationId: ConversationId) {
			zhongwen.tables.conversations.delete(conversationId);
			if (activeConversationId === conversationId) {
				activeConversationId = ensureDefaultConversation();
			}
		},

		/** Set the active conversation's provider, resetting model to that provider's first. */
		setProvider(provider: string) {
			if (!activeConversationId) return;
			const models = PROVIDER_MODELS[provider as Provider];
			updateConversation(activeConversationId, {
				provider,
				model: models?.[0] ?? DEFAULT_MODEL,
			});
		},

		setModel(model: string) {
			if (!activeConversationId) return;
			updateConversation(activeConversationId, { model });
		},

		[Symbol.dispose]() {
			unobserve();
			conversationsMap[Symbol.dispose]();
		},
	};
}

export type ChatState = ReturnType<typeof createChatState>;
