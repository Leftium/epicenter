<script module lang="ts">
	import { createAiChatFetch } from '@epicenter/svelte';
	import { auth } from '$platform/auth';

	// auth is a module singleton, so the wrapped fetch is built once and shared
	// across every mounted ConversationView.
	const aiChatFetch = createAiChatFetch(auth.fetch);

	/**
	 * How long after the last doc update a finish-less trailing assistant
	 * message still counts as live. Past this it derives as interrupted.
	 */
	const STREAM_GRACE_MS = 3000;
</script>

<script lang="ts">
	import { API_ROUTES } from '@epicenter/constants/api-routes';
	import { APP_URLS } from '@epicenter/constants/vite';
	import { Button } from '@epicenter/ui/button';
	import * as Chat from '@epicenter/ui/chat';
	import { generateId } from '@epicenter/workspace';
	import {
		appendUserMessage,
		type ChatDocMessage,
		observeChatDocMessages,
		readChatDocMessages,
	} from '@epicenter/workspace/ai';
	import { DEFAULT_MODEL, DEFAULT_PROVIDER } from '../chat/providers';
	import { ZHONGWEN_SYSTEM_PROMPT } from '../chat/system-prompt';
	import type { ConversationId } from '@epicenter/zhongwen';
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

	// The durable conversation row (provider/model/title) is read at action
	// time inside the send/kickoff handlers, never in the template (the header
	// owns its reactive display), so a plain read suffices here.
	function readRow() {
		return zhongwen.tables.conversations.get(conversationId).data;
	}

	// The component is keyed on conversationId, so it mounts fresh per
	// conversation: open the transcript doc synchronously and dispose it (and
	// the observer + ticker) on unmount. The cache's grace window absorbs quick
	// back-and-forth switching. conversationId is the keyed identity and never
	// changes within one instance, so a one-time read is intentional.
	// svelte-ignore state_referenced_locally
	const docHandle = zhongwen.conversationDocs.open(conversationId);

	let messages = $state.raw<ChatDocMessage[]>(
		readChatDocMessages(docHandle.ydoc),
	);
	let lastDocChangeAt = $state(0);
	const unobserve = observeChatDocMessages(docHandle.ydoc, () => {
		messages = readChatDocMessages(docHandle.ydoc);
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
	let sendError = $state<string | null>(null);
	let dismissedError = $state(false);
	let inputValue = $state('');

	const trailing = $derived(messages.at(-1));
	const isRemoteLive = $derived(
		trailing?.role === 'assistant' &&
			trailing.finish === undefined &&
			now - lastDocChangeAt < STREAM_GRACE_MS,
	);
	const isGenerating = $derived(kickoffController !== null || isRemoteLive);
	const isThinking = $derived(
		isGenerating &&
			(trailing?.role !== 'assistant' || trailing.text.length === 0),
	);
	const isInterrupted = $derived(
		trailing?.role === 'assistant' &&
			trailing.finish === undefined &&
			!isGenerating,
	);
	const failure = $derived(
		trailing?.finish?.kind === 'failed' ? trailing.finish : undefined,
	);
	const error = $derived(sendError ?? failure?.message ?? null);

	async function kickoffGeneration() {
		if (kickoffController) return;
		const controller = new AbortController();
		kickoffController = controller;
		sendError = null;
		dismissedError = false;
		const row = readRow();
		try {
			await aiChatFetch(API_ROUTES.ai.chatDoc.url(APP_URLS.API), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					guid: docHandle.ydoc.guid,
					generationId: generateId(),
					data: {
						provider: row?.provider ?? DEFAULT_PROVIDER,
						model: row?.model ?? DEFAULT_MODEL,
						systemPrompts: [ZHONGWEN_SYSTEM_PROMPT],
					},
				}),
				signal: controller.signal,
			});
			// The kickoff resolving (200) IS the finish signal for the requester.
			// The server cannot write the per-value-encrypted conversations table,
			// and a completed reply only lands while this requester is alive, so
			// the requester owns the list-recency bump on completion.
			zhongwen.tables.conversations.update(conversationId, {
				updatedAt: Date.now(),
			});
		} catch (err) {
			if (!controller.signal.aborted) {
				sendError = extractErrorMessage(err);
			}
		} finally {
			if (kickoffController === controller) kickoffController = null;
		}
	}

	function sendMessage(content: string) {
		const text = content.trim();
		if (!text || isGenerating) return;
		appendUserMessage(docHandle.ydoc, {
			id: generateId(),
			content: text,
			createdAt: Date.now(),
		});
		const title = readRow()?.title;
		zhongwen.tables.conversations.update(conversationId, {
			title: title === 'New Chat' ? text.slice(0, 50) : title,
			updatedAt: Date.now(),
		});
		void kickoffGeneration();
	}

	function retry() {
		sendError = null;
		dismissedError = false;
		void kickoffGeneration();
	}
</script>

<Chat.List class="flex-1 overflow-y-auto p-4" aria-live="polite">
	{#if messages.length === 0}
		<div class="flex flex-1 items-center justify-center text-muted-foreground">
			<p>Ask a question in English and get a response in Chinese and English.</p>
		</div>
	{:else}
		{#each messages as message (message.id)}
			<!-- An empty assistant message is the in-progress turn before its first
				token; the typing bubble below stands in for it. -->
			{#if message.role === 'user' || message.text.length > 0}
				<ChatMessage {message} {showPinyin} />
			{/if}
		{/each}
	{/if}

	{#if isThinking}
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
	{:else if isInterrupted}
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
	{isGenerating}
	onSend={sendMessage}
	onStop={() => kickoffController?.abort()}
/>
