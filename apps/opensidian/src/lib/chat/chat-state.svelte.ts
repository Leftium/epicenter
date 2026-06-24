/**
 * Reactive AI chat state: the one client agent loop (ADR-0047) per conversation.
 *
 * A conversation's turns live in its `messages` child doc, a last-write-wins
 * store of finished {@link AgentMessage} records. Each handle binds that store to
 * `createConversation`: the loop streams the live turn into component state,
 * dispatches tool calls, and writes each finished message into the doc the moment
 * the turn ends. The live turn never enters the CRDT, and the loop dies with the
 * tab; re-asking the reasoning is free.
 *
 * Inference rides the OpenAI-compatible gateway (ADR-0050; the house key over
 * `/v1/chat/completions`), reading the conversation's model and skill prompts per
 * turn. The base URL is the swap point: it defaults to the Epicenter gateway but
 * is the only thing a self-hosted or local backend (Ollama, vLLM) would change.
 * Tools are opensidian's own file and bash actions: opensidian has no daemon, so
 * they are the client's in-process actions, surfaced through
 * `createDispatchToolCatalog` (a local action resolves through `invokeAction`
 * with no relay). A mutation is approval-gated by a synchronous pause: the loop
 * waits on an in-client decision, recorded per handle in `pendingApproval`.
 *
 * The conversation list is the `conversations` table (title, model, recency);
 * the turns live in each conversation's doc.
 *
 * Components read this through `opensidian.state.chat`.
 */

import {
	asConversationId,
	type Conversation,
	type ConversationId,
	generateConversationId,
} from '@epicenter/chat';
import { createOpenAiAgentEngine } from '@epicenter/client';
import { InstantString } from '@epicenter/field';
import { bindAgentConversation, fromTable } from '@epicenter/svelte';
import {
	type AgentToolCall,
	createConversation,
	createDispatchToolCatalog,
	defaultApprovalDecision,
} from '@epicenter/workspace/agent';
import { generateChatMessageId } from 'opensidian';
import type { OpensidianBrowser } from 'opensidian/browser';
import { SvelteMap } from 'svelte/reactivity';
import { DEFAULT_MODEL } from '$lib/chat/models';
import {
	buildGlobalSkillsPrompt,
	buildVaultSkillsPrompt,
	OPENSIDIAN_SYSTEM_PROMPT,
} from '$lib/chat/system-prompt';
import { searchParams } from '$lib/search-params.svelte';
import { inferenceConnections } from '$lib/state/inference-connections.svelte';
import type { SkillState } from '$lib/state/skill-state.svelte';

export function createAiChatState({
	workspace,
	skills,
}: {
	workspace: OpensidianBrowser;
	skills: SkillState;
}) {
	const conversationsMap = fromTable(workspace.tables.conversations);
	const conversations = $derived(
		[...conversationsMap.values()].sort((a, b) =>
			b.updatedAt.localeCompare(a.updatedAt),
		),
	);

	// One tool catalog for every conversation: the union of opensidian's own
	// in-process actions (file and bash tools) and any peer's advertised actions.
	// A local action resolves through `invokeAction` without the relay; the
	// presence channel already excludes this node, so the file tools come only
	// from `localActions`.
	const toolCatalog = createDispatchToolCatalog(workspace.collaboration, {
		localActions: workspace.actions,
	});

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

		// The tool call the loop is waiting on a decision for, or null. A mutation
		// pauses the loop here (the present human is the gate, ADR-0047); a query
		// runs unattended and never lands here.
		let pendingApproval = $state<{
			call: AgentToolCall;
			resolve: (approved: boolean) => void;
		} | null>(null);

		function settleApproval(approved: boolean) {
			const decision = pendingApproval;
			if (!decision) return;
			pendingApproval = null;
			decision.resolve(approved);
		}

		// Bind the conversation's child doc to the loop. Inference reads this
		// conversation's model and the live skill prompts per turn, so a
		// mid-conversation model switch takes effect on the next answer.
		const convo = bindAgentConversation(
			createConversation({
				store:
					workspace.tables.conversations.docs.messages.open(conversationId),
				engine: createOpenAiAgentEngine({
					// The conversation's model (ADR-0055) is resolved per turn against this
					// device's connection set (ADR-0058), so a header switch lands on the
					// next turn. The hosted fallback is defensive: the UI gates sending when
					// no connection serves the model, so this only fires to error loudly at
					// the gateway rather than silently substituting a different model.
					data: () => {
						const m = metadata?.model ?? DEFAULT_MODEL;
						const transport =
							inferenceConnections.resolve(m) ?? inferenceConnections.hosted;
						return {
							...transport,
							model: m,
							systemPrompts: buildSystemPrompts(),
						};
					},
				}),
				tools: toolCatalog,
				approval: {
					decide: defaultApprovalDecision,
					request: (call) =>
						new Promise<boolean>((resolve) => {
							pendingApproval = { call, resolve };
						}),
				},
				generateId: generateChatMessageId,
			}),
		);

		// Map the loop's two-flag liveness onto the status the message list reads.
		const status = $derived.by(() => {
			if (convo.error) return 'error' as const;
			if (convo.isThinking) return 'submitted' as const;
			if (convo.isGenerating) return 'streaming' as const;
			return 'ready' as const;
		});

		return {
			[Symbol.dispose]() {
				// Unblock a pending approval so the awaiting loop unwinds, then abort.
				settleApproval(false);
				convo[Symbol.dispose]();
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
				return convo.messages;
			},

			/** The in-flight message, rendered separately so the settled list above
			 * stays referentially inert during a turn. Null between turns. */
			get streaming() {
				return convo.streaming;
			},

			get isLoading() {
				return convo.isGenerating;
			},

			get status() {
				return status;
			},

			get error() {
				return convo.error;
			},

			get isCreditsExhausted() {
				return convo.error?.code === 'InsufficientCredits';
			},

			get isUnauthorized() {
				return convo.error?.code === 'Unauthorized';
			},

			/** The tool call awaiting the user's decision, or null. */
			get pendingApprovalCallId() {
				return pendingApproval?.call.toolCallId ?? null;
			},

			sendMessage(content: string) {
				// The loop owns the empty/mid-turn guard; gate the title write on
				// whether it actually started a turn rather than re-deriving it.
				if (!convo.send(content)) return;

				const currentTitle = metadata?.title ?? 'New Chat';
				updateConversation(conversationId, {
					title:
						currentTitle === 'New Chat'
							? content.trim().slice(0, 50)
							: currentTitle,
				});
			},

			reload() {
				convo.retry();
			},

			stop() {
				// A turn parked on an approval is awaiting `request`, which only the
				// user settles; unblock it (as a denial) before aborting, the same
				// order dispose uses, so Stop is never inert mid-approval.
				settleApproval(false);
				convo.stop();
			},

			approveToolCall() {
				settleApproval(true);
			},
			denyToolCall() {
				settleApproval(false);
			},
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
			model: active?.model ?? DEFAULT_MODEL,
			createdAt: nowIso,
			updatedAt: nowIso,
		});

		searchParams.update({ chat: id });
		return id;
	}

	return {
		[Symbol.dispose]() {
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
