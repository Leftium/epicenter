<script module lang="ts">
	import { createAiChatFetch } from '@epicenter/client';
	import { auth } from '$platform/auth';

	// auth is a module singleton, so the wrapped fetch is built once and shared
	// across every mounted ConversationView.
	const aiChatFetch = createAiChatFetch(auth.fetch);
</script>

<script lang="ts">
	import { createEpicenterProviderChatStream } from '@epicenter/client';
	import { API_ROUTES } from '@epicenter/constants/api-routes';
	import { APP_URLS } from '@epicenter/constants/vite';
	import { Button } from '@epicenter/ui/button';
	import * as Chat from '@epicenter/ui/chat';
	import { generateId, InstantString } from '@epicenter/workspace';
	import {
		attachChatBrowserAnswerer,
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
	import { requireZhongwen } from '$lib/session';
	import ChatInput from './ChatInput.svelte';
	import ChatMessage from './ChatMessage.svelte';

	let {
		conversationId,
		showPinyin,
	}: { conversationId: ConversationId; showPinyin: boolean } = $props();

	const zhongwen = requireZhongwen();

	// The durable conversation row (title, bound agent) is read at action time,
	// never in the template, so a plain read suffices.
	function readRow() {
		return zhongwen.tables.conversations.get(conversationId).data;
	}

	// The component is keyed on conversationId, so it mounts fresh per
	// conversation: open the transcript doc synchronously and dispose it (and the
	// observer, ticker, and answerer) on unmount. The cache's grace window
	// absorbs quick back-and-forth switching. conversationId is the keyed identity
	// and never changes within one instance, so a one-time read is intentional.
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

	// 1s ticker so recency-derived liveness advances past the grace window even
	// when no doc events arrive.
	let now = $state(Date.now());
	const ticker = setInterval(() => {
		now = Date.now();
	}, 1000);

	// Who answers this conversation? A daemon-runtime agent is a resident
	// listener that answers ambiently over sync, so the browser stays out
	// (answering too would double-answer one turn). Any other binding (the cloud
	// agent) is answered in-process, here: the browser runs the same answerer the
	// daemon does, observing its own writes, claiming the turn, and sourcing
	// tokens from the Epicenter provider (the metered /api/ai/chat SSE stream).
	// The bound agent is immutable, so this decision never flips mid-conversation.
	// ADR-0021: a conversation is a synced doc only an in-process peer writes.
	// svelte-ignore state_referenced_locally
	const boundAgent = readRow()?.agent;
	const stopAnswerer =
		boundAgent !== undefined && agentConfig(boundAgent)?.runtime !== 'daemon'
			? attachChatBrowserAnswerer({
					doc: docHandle.ydoc,
					startStream: createEpicenterProviderChatStream({
						fetch: aiChatFetch,
						url: API_ROUTES.ai.chat.url(APP_URLS.API),
						data: () => ({
							model: ZHONGWEN_MODEL,
							systemPrompts: [ZHONGWEN_SYSTEM_PROMPT],
						}),
					}),
				})
			: undefined;

	onDestroy(() => {
		clearInterval(ticker);
		unobserve();
		stopAnswerer?.();
		docHandle[Symbol.dispose]();
	});

	let dismissedError = $state(false);
	let inputValue = $state('');

	// The shared doc -> render-state projection owns liveness, status, and the
	// terminal outcome. The browser answerer claims synchronously (the assistant
	// placeholder lands in the same transaction as the user turn), so there is no
	// external trigger to OR in; a provider error (a 402 out of credits, a network
	// failure) lands as a write-once `failed` finish that surfaces here.
	const render = $derived(
		chatRenderState(messages, { now, lastChangeAt: lastDocChangeAt }),
	);
	const error = $derived(render.failure?.message ?? null);

	/**
	 * A send is one durable transcript write: the user turn carries the
	 * `generationId` the answer it awaits is keyed to. The in-process answerer
	 * (or a bound daemon) observes the write and claims the turn. There is no
	 * kickoff and no second message table to reconcile.
	 */
	function sendMessage(content: string) {
		const text = content.trim();
		if (!text || render.isGenerating) return;
		dismissedError = false;
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
	}

	/**
	 * Stop the in-flight answer with the client-owned durable cancel: the answerer
	 * reads `cancelRequestedAt` back mid-stream and writes a cancelled finish, so
	 * it works from any device and after a disconnect. Single writer: the cancel
	 * lands on this client's own user turn.
	 */
	function stopGeneration() {
		docHandle.requestCancel(Date.now());
	}

	function retry() {
		dismissedError = false;
		// A terminal answer (failed or interrupted) is keyed to the old
		// generationId. Re-mint the turn's generationId so the answerer starts a
		// fresh generation instead of finding the answer already claimed.
		docHandle.remintGeneration(generateId());
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
			<Button size="sm" variant="outline" onclick={retry}>Retry</Button>
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
