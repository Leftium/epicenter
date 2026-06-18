<script module lang="ts">
	import { createAiChatFetch } from '@epicenter/client';
	import { auth } from '$platform/auth';

	// auth is a module singleton, so the wrapped fetch is built once and shared
	// across every mounted ConversationView.
	const aiChatFetch = createAiChatFetch(auth.fetch);
</script>

<script lang="ts">
	import {
		AiChatHttpError,
		type AiChatError,
	} from '@epicenter/constants/ai-chat-errors';
	import { API_ROUTES } from '@epicenter/constants/api-routes';
	import { APP_URLS } from '@epicenter/constants/vite';
	import { Button } from '@epicenter/ui/button';
	import * as Chat from '@epicenter/ui/chat';
	import { generateId, InstantString } from '@epicenter/workspace';
	import {
		type ChatDocMessage,
		chatRenderState,
		findActiveChatDocGeneration,
	} from '@epicenter/workspace/ai';
	import {
		agentConfig,
		type ConversationId,
		ZHONGWEN_MODEL,
		ZHONGWEN_SYSTEM_PROMPT,
	} from '@epicenter/zhongwen';
	import { onDestroy } from 'svelte';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { requireZhongwen } from '$lib/session';
	import ChatInput from './ChatInput.svelte';
	import ChatMessage from './ChatMessage.svelte';

	let {
		conversationId,
		showPinyin,
	}: { conversationId: ConversationId; showPinyin: boolean } = $props();

	const zhongwen = requireZhongwen();

	type SendError = {
		message: string;
		name?: AiChatError['name'];
	};

	// The durable conversation row (title) is read at action time inside the
	// send handler, never in the template, so a plain read suffices here.
	function readRow() {
		return zhongwen.tables.conversations.get(conversationId).data;
	}

	// The component is keyed on conversationId, so it mounts fresh per
	// conversation: open the transcript doc synchronously and dispose it (and
	// the observer + ticker) on unmount. The cache's grace window absorbs quick
	// back-and-forth switching. conversationId is the keyed identity and never
	// changes within one instance, so a one-time read is intentional.
	// svelte-ignore state_referenced_locally
	const docHandle =
		zhongwen.tables.conversations.docs.messages.open(conversationId);

	const initialMessages = docHandle.read();
	const mountedAt = Date.now();
	const initialActiveGeneration = findActiveChatDocGeneration(
		initialMessages,
		mountedAt,
	);
	let messages = $state.raw<ChatDocMessage[]>(initialMessages);
	let lastDocChangeAt = $state(initialActiveGeneration ? mountedAt : 0);
	const unobserve = docHandle.observe(() => {
		messages = docHandle.read();
		lastDocChangeAt = Date.now();
	});

	// 1s ticker so recency-derived liveness advances past the grace window
	// even when no doc events arrive.
	let now = $state(Date.now());
	const ticker = setInterval(() => {
		now = Date.now();
	}, 1000);

	onDestroy(() => {
		clearInterval(ticker);
		unobserve();
		docHandle[Symbol.dispose]();
	});

	let kickoffController = $state.raw<AbortController | null>(null);
	let sendError = $state<SendError | null>(null);
	let dismissedError = $state(false);
	let inputValue = $state('');

	// The shared doc -> render-state projection. The cloud kickoff's open HTTP
	// request is the one liveness signal the doc cannot yet show (the server has
	// not claimed), so it rides in as `externallyGenerating`.
	const render = $derived(
		chatRenderState(messages, {
			now,
			lastChangeAt: lastDocChangeAt,
			externallyGenerating: kickoffController !== null,
		}),
	);
	const error = $derived(sendError?.message ?? render.failure?.message ?? null);
	const canRetry = $derived(
		sendError?.name === 'GenerationInProgress'
			? render.activeGeneration === undefined
			: true,
	);

	/**
	 * Preserve the structured server-blocking error. A generic Retry button is a
	 * trap while the server still sees a recent unfinished assistant message.
	 */
	function toSendError(error: unknown): SendError {
		if (
			error instanceof AiChatHttpError &&
			error.detail.name === 'GenerationInProgress'
		) {
			return {
				name: error.detail.name,
				message: 'Previous response is still settling. Try again shortly.',
			};
		}

		return { message: extractErrorMessage(error) };
	}

	/**
	 * Nudge the conversation's bound agent. A `'cloud'`-runtime agent answers over
	 * the HTTP route, so a cloud-bound conversation kicks it off here. Any other
	 * runtime is an always-on reaction that answers over sync, so the browser does
	 * nothing: nudging it too would answer the same turn twice (the D3 hazard). The
	 * catalog owns that routing fork (`agentConfig().runtime`); the bound agent is
	 * immutable, so this decision never flips mid-conversation.
	 */
	function nudgeBoundAgent() {
		const agent = readRow()?.agent;
		if (agent === undefined || agentConfig(agent)?.runtime !== 'cloud') return;
		void kickoffGeneration();
	}

	/**
	 * Start one server reaction for this transcript doc. The AbortController is local
	 * UI state; durable progress and terminal outcome stay in the Yjs doc.
	 */
	async function kickoffGeneration() {
		if (kickoffController) return;
		const controller = new AbortController();
		kickoffController = controller;
		sendError = null;
		dismissedError = false;
		try {
			await aiChatFetch(API_ROUTES.ai.chatDoc.url(APP_URLS.API), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					guid: docHandle.guid,
					data: {
						model: ZHONGWEN_MODEL,
						systemPrompts: [ZHONGWEN_SYSTEM_PROMPT],
					},
				}),
				signal: controller.signal,
			});
			// The kickoff resolving (200) IS the finish signal for the requester.
			// The server generation reaction only writes the transcript child doc, not
			// the conversations list table, and a completed reply only lands while
			// this requester is alive, so the requester owns the list-recency bump.
			zhongwen.tables.conversations.update(conversationId, {
				updatedAt: InstantString.now(),
			});
		} catch (err) {
			if (!controller.signal.aborted) {
				sendError = toSendError(err);
			}
		} finally {
			if (kickoffController === controller) kickoffController = null;
		}
	}

	/**
	 * A send is one durable transcript write plus one control-plane kickoff. There
	 * is no second message table to reconcile.
	 */
	function sendMessage(content: string) {
		const text = content.trim();
		if (!text || render.isGenerating) return;
		// The turn carries the assistant id it awaits: the reaction reads this
		// generationId off the doc, so the kickoff POST need not carry it.
		docHandle.appendUser({
			id: generateId(),
			content: text,
			createdAt: Date.now(),
			generationId: generateId(),
		});
		const title = readRow()?.title;
		zhongwen.tables.conversations.update(conversationId, {
			title: title === 'New Chat' ? text.slice(0, 50) : title,
			updatedAt: InstantString.now(),
		});
		nudgeBoundAgent();
	}

	/**
	 * Stop the in-flight answer. Aborting the local kickoff fetch only stops the
	 * transitional HTTP path on this device; the durable cancel is the write the
	 * always-on reaction reads back, so it works after a disconnect and from any
	 * device. Single writer: the cancel lands on this client's own user turn.
	 */
	function stopGeneration() {
		kickoffController?.abort();
		docHandle.requestCancel(Date.now());
	}

	function retry() {
		sendError = null;
		dismissedError = false;
		// A terminal answer (failed or interrupted) is already keyed to the old
		// generationId. Re-mint the turn's generationId so the reaction starts a
		// fresh generation instead of replaying the no-op 409.
		docHandle.remintGeneration(generateId());
		nudgeBoundAgent();
	}
</script>

<Chat.List class="flex-1 overflow-y-auto p-4" aria-live="polite">
	{#if render.visibleMessages.length === 0}
		<div class="flex flex-1 items-center justify-center text-muted-foreground">
			<p>Ask a question in English and get a response in Chinese and English.</p>
		</div>
	{:else}
		<!-- visibleMessages drops the empty assistant placeholder of an in-progress
			turn; the typing bubble below stands in for it. -->
		{#each render.visibleMessages as message (message.id)}
			<ChatMessage {message} {showPinyin} />
		{/each}
	{/if}

	{#if render.isThinking}
		<Chat.Bubble variant="received">
			<Chat.BubbleMessage typing />
		</Chat.Bubble>
	{/if}

	{#if error && !dismissedError}
		<div
			class="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive"
		>
			<span class="flex-1">{error}</span>
			{#if canRetry}
				<Button size="sm" variant="outline" onclick={retry}>Retry</Button>
			{/if}
			<Button size="sm" variant="ghost" onclick={() => (dismissedError = true)}>
				✕
			</Button>
		</div>
	{:else if render.isInterrupted}
		<div
			class="flex items-center gap-2 rounded-md bg-muted p-3 text-sm text-muted-foreground"
		>
			<span class="flex-1">This reply was interrupted.</span>
			<Button size="sm" variant="outline" onclick={retry}>Retry</Button>
		</div>
	{/if}
</Chat.List>

<ChatInput
	bind:value={inputValue}
	isGenerating={render.isGenerating}
	onSend={sendMessage}
	onStop={stopGeneration}
/>
