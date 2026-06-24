/**
 * Reactive AI chat state with multi-conversation support.
 *
 * The conversation list is the synced `conversations` table (@epicenter/chat);
 * each conversation's turns live in its `messages` child doc, written by the one
 * client agent loop (ADR-0047). The loop streams the live turn into component
 * state and writes each finished message into the doc; the live turn never
 * enters the CRDT, and everything syncs across the user's devices.
 *
 * Inference rides the OpenAI-compatible gateway (ADR-0049/0050): the engine POSTs
 * `/v1/chat/completions`, reading the conversation's model and the device system
 * prompts per turn. Tools are tab-manager's own browser actions, surfaced through
 * `createDispatchToolCatalog` (a local action resolves through `invokeAction`
 * with no relay). A mutation is approval-gated by a synchronous pause; the
 * "Always Allow" trust set decides `auto` so a trusted tool never pauses again.
 *
 * A handle registry mirrors the table: `reconcileHandles` opens a handle for
 * every row and disposes one whose row is gone. Creating a conversation writes a
 * row (model carried forward from the active one); its title is set from the
 * first user message; deleting removes the row and its handle.
 *
 * Components read this through `workspace.state.aiChat`.
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
import { type Collaboration, generateId } from '@epicenter/workspace';
import {
	type AgentToolCall,
	agentMessageText,
	createConversation as createAgentConversation,
	createDispatchToolCatalog,
	defaultApprovalDecision,
} from '@epicenter/workspace/agent';
import { SvelteMap } from 'svelte/reactivity';
import { DEFAULT_MODEL } from '$lib/chat/models';
import {
	buildDeviceConstraints,
	TAB_MANAGER_SYSTEM_PROMPT,
} from '$lib/chat/system-prompt';
import { inferenceConnections } from '$lib/state/inference-connections.svelte';
import type { ToolTrustState } from '$lib/state/tool-trust.svelte';
import type { TabManagerBrowser } from '$lib/tab-manager/extension';

export function createAiChatState({
	tabManager,
	collaboration,
	toolTrust,
}: {
	tabManager: TabManagerBrowser;
	collaboration: Collaboration;
	toolTrust: ToolTrustState;
}) {
	// The conversation list is the synced `conversations` table; a row's turns
	// live in its `messages` child doc. This reactive map drives the registry.
	const conversationsMap = fromTable(tabManager.tables.conversations);

	// One catalog for every conversation: tab-manager's own browser actions,
	// resolved in-process through `invokeAction` with no relay. Peers (other
	// signed-in devices) advertise their actions too; a local action shadows a
	// remote one of the same name.
	const toolCatalog = createDispatchToolCatalog(collaboration, {
		localActions: tabManager.actions,
		selfNodeId: tabManager.nodeId,
	});

	/** Patch a conversation row and bump its recency in one write. */
	function updateConversation(
		conversationId: ConversationId,
		patch: Partial<Omit<Conversation, 'id'>>,
	) {
		tabManager.tables.conversations.update(conversationId, {
			...patch,
			updatedAt: InstantString.now(),
		});
	}

	// ── Handle Registry (one handle per conversation row) ──────────────

	const handles = new SvelteMap<
		ConversationId,
		ReturnType<typeof createConversationHandle>
	>();

	/** The conversation list for the picker: handles sorted most-recent first. */
	const conversationList = $derived(
		[...handles.values()].sort((a, b) =>
			b.updatedAt.localeCompare(a.updatedAt),
		),
	);

	/**
	 * Create a self-contained reactive handle for a single conversation.
	 *
	 * Binds the conversation's `messages` child doc to `createConversation` (the
	 * one client agent loop) through `bindAgentConversation`. Title and model read
	 * from the row; the engine reads the model and device prompts per turn, so a
	 * mid-conversation model switch takes effect on the next answer.
	 */
	function createConversationHandle(conversationId: ConversationId) {
		let inputValue = $state('');
		let dismissedError = $state<string | null>(null);

		const metadata = $derived(conversationsMap.get(conversationId));
		/** The conversation's model (ADR-0055), defaulted once for both the engine
		 * turn and the picker's `model` getter. */
		const currentModel = $derived(metadata?.model ?? DEFAULT_MODEL);

		// The tool call the loop is waiting on a decision for, or null. A mutation
		// pauses the loop here (the present human is the gate, ADR-0047); a query,
		// or a tool the user trusted, runs unattended and never lands here.
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

		const convo = bindAgentConversation(
			createAgentConversation({
				store:
					tabManager.tables.conversations.docs.messages.open(conversationId),
				engine: createOpenAiAgentEngine({
					// The conversation's model (ADR-0055) is resolved per turn against this
					// device's connection set (ADR-0059), so a switch lands on the next
					// turn. `resolveOrHosted` falls back to the hosted gateway for a model no
					// device connection serves; the UI gates sending in that case, so the
					// fallback only errors loudly rather than silently substituting a model.
					data: () => {
						const transport =
							inferenceConnections.resolveOrHosted(currentModel);
						return {
							...transport,
							model: currentModel,
							systemPrompts: [
								buildDeviceConstraints(tabManager.nodeId),
								TAB_MANAGER_SYSTEM_PROMPT,
							],
						};
					},
				}),
				tools: toolCatalog,
				approval: {
					// A tool the user chose to "Always Allow" auto-approves; otherwise a
					// query runs unattended and a mutation asks (ADR-0044).
					decide: (call, definition) =>
						toolTrust.shouldAutoApprove(call.toolName)
							? 'auto'
							: defaultApprovalDecision(call, definition),
					request: (call) =>
						new Promise<boolean>((resolve) => {
							pendingApproval = { call, resolve };
						}),
				},
				generateId,
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

			// ── Identity and metadata (from the row) ──

			get id() {
				return conversationId;
			},

			get title() {
				return metadata?.title ?? 'New Chat';
			},

			/** Recency for the conversation list, as the row's ISO instant. */
			get updatedAt() {
				return metadata?.updatedAt ?? '';
			},

			get lastMessagePreview() {
				const last = convo.messages.at(-1);
				if (!last) return '';
				const text = agentMessageText(last).trim();
				return text.length > 60 ? `${text.slice(0, 60)}…` : text;
			},

			// ── Model choice (a row column) ──

			get model() {
				return currentModel;
			},
			set model(value: string) {
				updateConversation(conversationId, { model: value });
			},

			// ── Chat state (from the loop) ──

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

			get error() {
				return convo.error;
			},

			get status() {
				return status;
			},

			/** Credits are exhausted (HTTP 402); UI should prompt an upgrade. */
			get isCreditsExhausted() {
				return convo.error?.code === 'InsufficientCredits';
			},

			get isUnauthorized() {
				return convo.error?.code === 'Unauthorized';
			},

			// ── Tool approval ──

			/** The tool call awaiting the user's decision, or null. */
			get pendingApprovalCallId() {
				return pendingApproval?.call.toolCallId ?? null;
			},

			approveToolCall() {
				settleApproval(true);
			},

			denyToolCall() {
				settleApproval(false);
			},

			/** Trust this tool from now on, then approve the pending call. */
			alwaysAllowToolCall() {
				const toolName = pendingApproval?.call.toolName;
				if (toolName) toolTrust.allow(toolName);
				settleApproval(true);
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

			// ── Actions ──

			sendMessage(content: string) {
				const text = content.trim();
				if (!text || convo.isGenerating) return;

				convo.send(text);

				// First user message names the conversation; later sends just bump
				// recency (updateConversation always writes updatedAt).
				const currentTitle = metadata?.title ?? 'New Chat';
				updateConversation(conversationId, {
					title: currentTitle === 'New Chat' ? text.slice(0, 50) : currentTitle,
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

			delete() {
				deleteConversation(conversationId);
			},
		};
	}

	/** Dispose the loop and remove the handle for a conversation. */
	function destroyConversation(id: ConversationId) {
		handles.get(id)?.[Symbol.dispose]();
		handles.delete(id);
	}

	// ── Active Conversation ──────────────────────────────────────────

	let activeConversationId = $state<ConversationId | null>(null);

	/**
	 * Mirror the table into the handle registry: open a handle for every row,
	 * dispose one whose row is gone, and keep an active conversation selected.
	 */
	function reconcileHandles() {
		for (const id of handles.keys()) {
			if (!conversationsMap.has(id)) destroyConversation(id);
		}
		for (const id of conversationsMap.keys()) {
			const conversationId = asConversationId(id);
			if (!handles.has(conversationId)) {
				handles.set(conversationId, createConversationHandle(conversationId));
			}
		}

		// Keep an active conversation pointed at a live handle.
		if (activeConversationId !== null && handles.has(activeConversationId)) {
			return;
		}
		const mostRecent = conversationList[0];
		if (mostRecent) activeConversationId = mostRecent.id;
	}

	const _unobserve = tabManager.tables.conversations.observe(() => {
		reconcileHandles();
	});

	// Once the synced doc has loaded, mirror it in and guarantee a conversation
	// to land in (a fresh install has none).
	void tabManager.idb.whenLoaded.then(() => {
		reconcileHandles();
		if (conversationList.length === 0) createConversation();
	});

	reconcileHandles();

	// ── Conversation CRUD ────────────────────────────────────────────

	/**
	 * Open a new conversation, carrying the active conversation's model choice
	 * forward, and activate it. The handle is created synchronously so the UI
	 * never sees a momentarily-missing active conversation.
	 */
	function createConversation(): ConversationId {
		const id = generateConversationId();
		const nowIso = InstantString.now();
		const current =
			activeConversationId === null
				? undefined
				: handles.get(activeConversationId);

		tabManager.tables.conversations.set({
			id,
			title: 'New Chat',
			model: current?.model ?? DEFAULT_MODEL,
			createdAt: nowIso,
			updatedAt: nowIso,
		});
		if (!handles.has(id)) handles.set(id, createConversationHandle(id));
		activeConversationId = id;
		return id;
	}

	function deleteConversation(conversationId: ConversationId) {
		tabManager.tables.conversations.delete(conversationId);
		destroyConversation(conversationId);

		if (activeConversationId === conversationId) {
			const next = conversationList[0];
			if (next) {
				activeConversationId = next.id;
			} else {
				createConversation();
			}
		}
	}

	// ── Public API ────────────────────────────────────────────────────

	return {
		[Symbol.dispose]() {
			_unobserve();
			for (const id of [...handles.keys()]) {
				destroyConversation(id);
			}
			conversationsMap[Symbol.dispose]();
		},

		get active() {
			return activeConversationId === null
				? undefined
				: handles.get(activeConversationId);
		},

		get conversations() {
			return conversationList;
		},

		get activeConversationId() {
			return activeConversationId;
		},

		createConversation,

		switchTo(conversationId: ConversationId) {
			activeConversationId = conversationId;
		},
	};
}

/** A reactive handle for a single conversation backed by the client loop. */
type AiChatState = ReturnType<typeof createAiChatState>;
export type ConversationHandle = NonNullable<AiChatState['active']>;
