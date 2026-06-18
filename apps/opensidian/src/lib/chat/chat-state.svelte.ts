/**
 * Reactive AI chat state, rendered from the conversation doc.
 *
 * Since the render-from-doc migration (ADR-0021, Phase C), a conversation is a
 * synced transcript child doc, not a `createChat` in-memory state plus a
 * `chatMessages` table. Each handle opens its conversation's transcript
 * (`tables.conversations.docs.messages`), renders from `read()` / `observe()`,
 * and runs an in-process answerer (`docHandle.answer`) whose inference rides the
 * metered Epicenter provider (the house key over `/api/ai/chat`). A send is one
 * local doc write (the optimistic echo); the answerer claims that turn and
 * streams the reply into the same doc, so every device renders one stream.
 *
 * The conversation list is the `conversations` table (title, model, recency);
 * the turns live in each conversation's doc. There is no second conversation
 * store and no `onFinish` persistence: the doc is the single owner.
 *
 * Tools are not wired in this path. Opensidian's chat had file/bash tools behind
 * a per-call approval UX, but the text-only browser answerer does not run the
 * tool loop (that is Phase B: the agentic loop in the answer core plus
 * doc-mediated approval). `approveToolCall` / `denyToolCall` stay on the handle
 * as inert no-ops so the components keep their shape; no tool-call parts are
 * produced, so they never fire.
 *
 * Components read this through `opensidian.state.chat`.
 */

import type { AuthClient } from '@epicenter/auth';
import { createAiChatFetch } from '@epicenter/client';
import { API_ROUTES } from '@epicenter/constants/api-routes';
import { APP_URLS } from '@epicenter/constants/vite';
import { InstantString } from '@epicenter/field';
import { fromTable } from '@epicenter/svelte';
import { generateId } from '@epicenter/workspace';
import { type ChatDocMessage, chatRenderState } from '@epicenter/workspace/ai';
import {
	asConversationId,
	type Conversation,
	type ConversationId,
	generateConversationId,
} from 'opensidian';
import type { OpensidianBrowser } from 'opensidian/browser';
import { SvelteMap } from 'svelte/reactivity';
import { createEpicenterProviderChatStream } from '$lib/chat/epicenter-provider';
import { DEFAULT_MODEL } from '$lib/chat/models';
import {
	buildGlobalSkillsPrompt,
	buildVaultSkillsPrompt,
	OPENSIDIAN_SYSTEM_PROMPT,
} from '$lib/chat/system-prompt';
import { chatDocMessageToUiMessage } from '$lib/chat/ui-message';
import { searchParams } from '$lib/search-params.svelte';
import type { SkillState } from '$lib/state/skill-state.svelte';

export function createAiChatState({
	auth,
	workspace,
	skills,
}: {
	auth: AuthClient;
	workspace: OpensidianBrowser;
	skills: SkillState;
}) {
	const aiChatUrl = API_ROUTES.ai.chat.url(APP_URLS.API);
	const aiFetch = createAiChatFetch(auth.fetch);

	const conversationsMap = fromTable(workspace.tables.conversations);
	const conversations = $derived(
		[...conversationsMap.values()].sort((a, b) =>
			b.updatedAt.localeCompare(a.updatedAt),
		),
	);

	// One shared liveness clock for every handle, so an interrupted answer (no
	// finish written) decays past the grace window without a timer per handle.
	let now = $state(Date.now());
	const ticker = setInterval(() => {
		now = Date.now();
	}, 1000);

	/** The layered system prompts an answer is generated under, read per turn. */
	function buildSystemPrompts(): string[] {
		return [
			OPENSIDIAN_SYSTEM_PROMPT,
			buildGlobalSkillsPrompt(
				skills.globalSkills.map((skill) => ({
					name: skill.name,
					instructions: skill.instructions,
				})),
			),
			buildVaultSkillsPrompt(
				skills.vaultSkills.map((skill) => ({
					name: skill.name,
					content: skill.content,
				})),
			),
		].filter(Boolean);
	}

	function updateConversation(
		conversationId: ConversationId,
		patch: Partial<Omit<Conversation, 'id'>>,
	) {
		workspace.tables.conversations.update(conversationId, {
			...patch,
			updatedAt: InstantString.now(),
		});
	}

	function ensureDefaultConversation(): ConversationId | undefined {
		if (conversations.length > 0) return undefined;

		const id = generateConversationId();
		const nowIso = InstantString.now();
		workspace.tables.conversations.set({
			id,
			title: 'New Chat',
			parentId: null,
			sourceMessageId: null,
			systemPrompt: null,
			model: DEFAULT_MODEL,
			createdAt: nowIso,
			updatedAt: nowIso,
		});
		return id;
	}

	const handles = new SvelteMap<
		ConversationId,
		ReturnType<typeof createConversationHandle>
	>();

	function createConversationHandle(conversationId: ConversationId) {
		const metadata = $derived(conversationsMap.get(conversationId));

		// The transcript child doc is the single source of truth. Open it once
		// (the handle is keyed by conversationId), render from snapshots, and run
		// the in-process answerer over it.
		const docHandle =
			workspace.tables.conversations.docs.messages.open(conversationId);

		let docMessages = $state.raw<ChatDocMessage[]>(docHandle.read());
		let lastDocChangeAt = $state(0);
		const unobserve = docHandle.observe(() => {
			docMessages = docHandle.read();
			lastDocChangeAt = Date.now();
		});

		// The answerer's inference backend: the Epicenter provider, reading the
		// conversation's current model and skill prompts per turn.
		const stopAnswerer = docHandle.answer(
			createEpicenterProviderChatStream({
				fetch: aiFetch,
				url: aiChatUrl,
				data: () => ({
					model: metadata?.model ?? DEFAULT_MODEL,
					systemPrompts: buildSystemPrompts(),
				}),
			}),
		);

		// The shared doc -> render-state projection owns liveness/status; the only
		// thing left here is converting the visible doc messages to UIMessage for
		// the render components. opensidian is browser-answered (the claim is
		// synchronous), so there is no external trigger to OR in.
		const render = $derived(
			chatRenderState(docMessages, { now, lastChangeAt: lastDocChangeAt }),
		);
		const messages = $derived(
			render.visibleMessages.map(chatDocMessageToUiMessage),
		);

		return {
			[Symbol.dispose]() {
				// Stop the answerer (aborts any in-flight stream; no finish, an
				// interrupted artifact the user can retry) before disposing the doc.
				stopAnswerer();
				unobserve();
				docHandle[Symbol.dispose]();
			},

			get id() {
				return conversationId;
			},

			get title() {
				return metadata?.title ?? 'New Chat';
			},

			get model() {
				return metadata?.model ?? DEFAULT_MODEL;
			},
			set model(value: string) {
				updateConversation(conversationId, { model: value });
			},

			get messages() {
				return messages;
			},

			get isLoading() {
				return render.isGenerating;
			},

			get status() {
				return render.status;
			},

			get error() {
				return render.failure ? { message: render.failure.message } : null;
			},

			get isCreditsExhausted() {
				return render.failure?.code === 'InsufficientCredits';
			},

			get isUnauthorized() {
				return render.failure?.code === 'Unauthorized';
			},

			sendMessage(content: string) {
				const text = content.trim();
				if (!text || render.isGenerating) return;

				// One durable transcript write: the user turn carries the assistant
				// id it awaits, and the answerer reads it off the doc and claims.
				docHandle.appendUser({
					id: generateId(),
					content: text,
					createdAt: Date.now(),
					generationId: generateId(),
				});

				const currentTitle = metadata?.title ?? 'New Chat';
				updateConversation(conversationId, {
					title:
						currentTitle === 'New Chat' ? text.slice(0, 50) : currentTitle,
				});
			},

			reload() {
				// Re-mint the latest turn's generationId so the answerer starts a
				// fresh generation instead of seeing the old answer already claimed.
				docHandle.remintGeneration(generateId());
			},

			stop() {
				// The durable cancel the answerer reads back; it aborts the stream and
				// writes a `cancelled` finish, so it works from any device.
				docHandle.requestCancel(Date.now());
			},

			// Tool approval is Phase B (the answer core does not run the tool loop
			// yet), so these are inert: no tool-call parts are produced to approve.
			approveToolCall(_approvalId: string) {},
			denyToolCall(_approvalId: string) {},
		};
	}

	function destroyConversation(conversationId: ConversationId) {
		handles.get(conversationId)?.[Symbol.dispose]();
		handles.delete(conversationId);
	}

	const activeConversationId = $derived(
		asConversationId(searchParams.chat ?? ''),
	);

	function reconcileHandles() {
		for (const conversationId of handles.keys()) {
			if (!conversationsMap.has(conversationId as string)) {
				destroyConversation(conversationId);
			}
		}

		for (const conversationId of conversationsMap.keys()) {
			const id = asConversationId(conversationId);
			if (!handles.has(id)) {
				handles.set(id, createConversationHandle(id));
			}
		}

		const firstConversation = conversations[0];
		if (!firstConversation) return;
		if (handles.has(activeConversationId)) return;
		searchParams.update({ chat: asConversationId(firstConversation.id) });
	}

	const _unobserveConversations = workspace.tables.conversations.observe(() => {
		reconcileHandles();
	});

	void workspace.idb.whenLoaded.then(() => {
		void skills.loadAllSkills();
		reconcileHandles();

		const newId = ensureDefaultConversation();
		if (newId) {
			searchParams.update({ chat: newId });
			return;
		}

		const firstConversation = conversations[0];
		if (firstConversation) {
			searchParams.update({ chat: asConversationId(firstConversation.id) });
		}
	});

	reconcileHandles();

	function newConversation() {
		const id = generateConversationId();
		const nowIso = InstantString.now();
		const active = handles.get(activeConversationId);

		workspace.tables.conversations.set({
			id,
			title: 'New Chat',
			parentId: null,
			sourceMessageId: null,
			systemPrompt: null,
			model: active?.model ?? DEFAULT_MODEL,
			createdAt: nowIso,
			updatedAt: nowIso,
		});

		searchParams.update({ chat: id });
		return id;
	}

	return {
		[Symbol.dispose]() {
			clearInterval(ticker);
			_unobserveConversations();
			conversationsMap[Symbol.dispose]();
			for (const conversationId of [...handles.keys()]) {
				destroyConversation(conversationId);
			}
		},

		get active() {
			return handles.get(activeConversationId);
		},

		get isLoading() {
			return handles.get(activeConversationId)?.isLoading ?? false;
		},

		get model() {
			return handles.get(activeConversationId)?.model ?? DEFAULT_MODEL;
		},
		set model(value: string) {
			const active = handles.get(activeConversationId);
			if (!active) return;
			active.model = value;
		},

		sendMessage(content: string) {
			handles.get(activeConversationId)?.sendMessage(content);
		},

		stop() {
			handles.get(activeConversationId)?.stop();
		},

		newConversation,
	};
}
