/**
 * Reactive AI chat state for Zhongwen over doc-as-wire.
 *
 * The transcript of each conversation lives in its own synced Yjs child doc
 * (`zhongwen.conversationDocs`); the server generation actor streams
 * assistant tokens into that doc as a sync peer. This module renders the
 * doc and drives the control plane:
 *
 *   messages    observer on the conversation doc -> reactive snapshots
 *   send        append the user message map, bump the conversations row,
 *               POST the kickoff (no message history in the body)
 *   stop        abort the kickoff fetch; the server writes finish: cancelled
 *   liveness    derived from update recency, never stored: a trailing
 *               assistant message without `finish` is streaming while
 *               updates are recent, interrupted once they go quiet
 *
 * Only the ACTIVE conversation holds its doc open (IDB + websocket); the
 * sidebar list reads the cheap conversations table.
 */

import { API_ROUTES } from '@epicenter/constants/api-routes';
import { APP_URLS } from '@epicenter/constants/vite';
import { createAiChatFetch, fromTable } from '@epicenter/svelte';
import { generateId } from '@epicenter/workspace';
import {
	appendUserMessage,
	type ChatDocMessage,
	observeChatDocMessages,
	readChatDocMessages,
} from '@epicenter/workspace/ai';
import {
	type Conversation,
	type ConversationId,
	generateConversationId,
} from '@epicenter/zhongwen';
import { SvelteMap } from 'svelte/reactivity';
import { extractErrorMessage } from 'wellcrafted/error';
import { requireZhongwen } from '$lib/session';
import { auth } from '$platform/auth';
import {
	DEFAULT_MODEL,
	DEFAULT_PROVIDER,
	PROVIDER_MODELS,
	type Provider,
} from './providers';
import { ZHONGWEN_SYSTEM_PROMPT } from './system-prompt';

/**
 * How long after the last doc update a finish-less trailing assistant
 * message still counts as live. Past this, it derives as interrupted.
 */
const STREAM_GRACE_MS = 3000;

const aiChatFetch = createAiChatFetch(auth.fetch);

// ─── State Factory ───────────────────────────────────────────────────────────

export function createChatState() {
	const zhongwen = requireZhongwen();

	// ── Conversation List (root-doc table; cheap, no child docs) ──

	const conversationsMap = fromTable(zhongwen.tables.conversations);
	const conversations = $derived(
		[...conversationsMap.values()].sort((a, b) => b.updatedAt - a.updatedAt),
	);

	/** Per-conversation input drafts, preserved across switches. */
	const drafts = new SvelteMap<ConversationId, string>();

	/** 1s ticker feeding the recency-derived liveness states. */
	let now = $state(Date.now());
	const ticker = setInterval(() => {
		now = Date.now();
	}, 1000);

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

	// ── Active Conversation Session ──
	// One open transcript doc at a time. Switching disposes the previous
	// session's doc handle (the cache's grace window absorbs quick
	// back-and-forth) but does NOT abort an in-flight generation: the server
	// keeps streaming into the room and the transcript catches up on resync.

	function openSession(conversationId: ConversationId) {
		const docHandle = zhongwen.conversationDocs.open(conversationId);

		let messages = $state.raw<ChatDocMessage[]>(
			readChatDocMessages(docHandle.ydoc),
		);
		let lastDocChangeAt = $state(0);
		const unobserve = observeChatDocMessages(docHandle.ydoc, () => {
			messages = readChatDocMessages(docHandle.ydoc);
			lastDocChangeAt = Date.now();
		});

		let kickoffController = $state.raw<AbortController | null>(null);
		/** Kickoff failures never reach the doc; they surface here. */
		let sendError = $state<string | null>(null);

		const metadata = $derived(conversationsMap.get(conversationId));
		const trailing = $derived(messages.at(-1));
		/** A finish-less trailing assistant message with recent updates is live. */
		const isRemoteLive = $derived(
			trailing?.role === 'assistant' &&
				trailing.finish === undefined &&
				now - lastDocChangeAt < STREAM_GRACE_MS,
		);
		const isGenerating = $derived(kickoffController !== null || isRemoteLive);
		const isInterrupted = $derived(
			trailing?.role === 'assistant' &&
				trailing.finish === undefined &&
				!isGenerating,
		);
		const failure = $derived(
			trailing?.finish?.kind === 'failed' ? trailing.finish : undefined,
		);

		async function kickoffGeneration() {
			if (kickoffController) return;
			const controller = new AbortController();
			kickoffController = controller;
			sendError = null;
			try {
				await aiChatFetch(API_ROUTES.ai.chatDoc.url(APP_URLS.API), {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						guid: docHandle.ydoc.guid,
						generationId: generateId(),
						data: {
							provider: metadata?.provider ?? DEFAULT_PROVIDER,
							model: metadata?.model ?? DEFAULT_MODEL,
							systemPrompts: [ZHONGWEN_SYSTEM_PROMPT],
						},
					}),
					signal: controller.signal,
				});
				// The kickoff resolving (200) IS the finish signal for the
				// requester. The server cannot write the per-value-encrypted
				// conversations table, and a completed reply can only land while
				// this requester is alive, so bumping list recency here is the
				// reliable owner of conversations.updatedAt on completion.
				updateConversation(conversationId, {});
			} catch (error) {
				if (!controller.signal.aborted) {
					sendError = extractErrorMessage(error);
				}
			} finally {
				if (kickoffController === controller) kickoffController = null;
			}
		}

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

			get inputValue() {
				return drafts.get(conversationId) ?? '';
			},
			set inputValue(value: string) {
				drafts.set(conversationId, value);
			},

			get messages() {
				return messages;
			},

			get isGenerating() {
				return isGenerating;
			},

			/** Generating, but no assistant text has landed yet. */
			get isThinking() {
				return (
					isGenerating &&
					(trailing?.role !== 'assistant' || trailing.text.length === 0)
				);
			},

			get isInterrupted() {
				return isInterrupted;
			},

			get error() {
				return sendError ?? failure?.message ?? null;
			},

			sendMessage(content: string) {
				const text = content.trim();
				if (!text || isGenerating) return;
				appendUserMessage(docHandle.ydoc, {
					id: generateId(),
					content: text,
					createdAt: Date.now(),
				});
				updateConversation(conversationId, {
					title:
						metadata?.title === 'New Chat'
							? text.slice(0, 50)
							: metadata?.title,
				});
				void kickoffGeneration();
			},

			/** Re-kick after a failed or interrupted turn; the prompt is the doc as it stands. */
			retry() {
				sendError = null;
				void kickoffGeneration();
			},

			stop() {
				kickoffController?.abort();
			},

			/**
			 * Release the transcript doc. Deliberately does NOT abort an
			 * in-flight kickoff: the generation belongs to the conversation,
			 * not to this view of it.
			 */
			close() {
				unobserve();
				docHandle[Symbol.dispose]();
			},
		};
	}

	let activeSession = $state.raw<ReturnType<typeof openSession> | null>(null);

	function switchConversation(conversationId: ConversationId) {
		if (activeSession?.id === conversationId) return;
		activeSession?.close();
		activeSession = openSession(conversationId);
	}

	// ── Lifecycle ──

	// If the active conversation's row disappears (deleted on another
	// device), fall back to the default conversation.
	const unobserveConversations = zhongwen.tables.conversations.observe(() => {
		if (activeSession && !conversationsMap.has(activeSession.id)) {
			activeSession.close();
			activeSession = null;
			switchConversation(ensureDefaultConversation());
		}
	});

	// Initialize after persistence loads.
	void zhongwen.idb.whenLoaded.then(() => {
		if (!activeSession) switchConversation(ensureDefaultConversation());
	});

	// ── Conversation CRUD ──

	function createConversation(): ConversationId {
		const id = generateConversationId();
		const timestamp = Date.now();

		zhongwen.tables.conversations.set({
			id,
			title: 'New Chat',
			provider: activeSession?.provider ?? DEFAULT_PROVIDER,
			model: activeSession?.model ?? DEFAULT_MODEL,
			createdAt: timestamp,
			updatedAt: timestamp,
		});

		switchConversation(id);
		return id;
	}

	function deleteConversation(conversationId: ConversationId) {
		if (activeSession?.id === conversationId) {
			activeSession.close();
			activeSession = null;
		}
		drafts.delete(conversationId);
		zhongwen.tables.conversations.delete(conversationId);
		if (!activeSession) {
			switchConversation(ensureDefaultConversation());
		}
	}

	// ── Public API ──

	return {
		get active() {
			return activeSession ?? undefined;
		},

		get conversations() {
			return conversations;
		},

		get activeConversationId() {
			return activeSession?.id;
		},

		createConversation,

		switchTo: switchConversation,

		deleteConversation,

		[Symbol.dispose]() {
			clearInterval(ticker);
			unobserveConversations();
			conversationsMap[Symbol.dispose]();
			activeSession?.close();
			activeSession = null;
		},
	};
}

export type ChatState = ReturnType<typeof createChatState>;
export type ConversationSession = NonNullable<ChatState['active']>;
