<script module lang="ts">
	import { APP_URLS } from '@epicenter/constants/vite';
	import { createVocabEngine } from '@epicenter/vocab/engine';
	import { auth } from '$platform/auth';
	import { inferenceBackend } from '$lib/state/inference-backend.svelte';

	// One engine, built once and shared across every mounted conversation view.
	// The backend is read per turn from the device setting (ADR-0054): the metered
	// Epicenter gateway, or a custom OpenAI-compatible URL (a local Ollama).
	const clientEngine = createVocabEngine({
		fetch: auth.fetch,
		baseURL: APP_URLS.API,
		backend: () => inferenceBackend.current,
	});
</script>

<script lang="ts">
	import { bindAgentConversation } from '@epicenter/svelte';
	import { Button } from '@epicenter/ui/button';
	import * as Chat from '@epicenter/ui/chat';
	import type { ConversationId } from '@epicenter/chat';
	import { generateMessageId } from '@epicenter/vocab';
	import { InstantString } from '@epicenter/workspace';
	import { createConversation as createAgentConversation } from '@epicenter/workspace/agent';
	import { onDestroy } from 'svelte';
	import { requireVocab } from '$lib/session';
	import ChatInput from './ChatInput.svelte';
	import ChatMessage from './ChatMessage.svelte';

	let {
		conversationId,
		showPinyin,
	}: { conversationId: ConversationId; showPinyin: boolean } = $props();

	const vocab = requireVocab();

	// The component is keyed on conversationId, so it mounts fresh per
	// conversation: open the message store and bind it to the inference engine.
	// The controller owns streaming, persistence, and the render state; dispose
	// on unmount. Vocab is capability-free (ADR-0047), so the loop runs with no
	// tools: a single text step per turn, answered over the metered inference
	// stream and persisted as last-write-wins messages keyed by id (ADR-0046).
	// svelte-ignore state_referenced_locally
	const convo = bindAgentConversation(
		createAgentConversation({
			store: vocab.tables.conversations.docs.messages.open(conversationId),
			engine: clientEngine,
			generateId: generateMessageId,
		}),
	);

	onDestroy(() => convo[Symbol.dispose]());

	let dismissedError = $state(false);
	let inputValue = $state('');

	/**
	 * A send persists the user turn and starts the answer; the controller streams
	 * the reply into component state and writes the finished message to the store.
	 * The loop owns the empty/mid-turn guard, so we gate the title write on whether
	 * it actually started a turn rather than re-deriving the same condition.
	 */
	function sendMessage(content: string) {
		dismissedError = false;
		if (!convo.send(content)) return;
		const title = vocab.tables.conversations.get(conversationId).data?.title;
		vocab.tables.conversations.update(conversationId, {
			title: title === 'New Chat' ? content.trim().slice(0, 50) : title,
			updatedAt: InstantString.now(),
		});
	}

	function retry() {
		dismissedError = false;
		convo.retry();
	}
</script>

<Chat.List class="flex-1 overflow-y-auto p-4" aria-live="polite">
	{#if convo.messages.length === 0 && !convo.streaming}
		<div class="flex flex-1 items-center justify-center text-muted-foreground">
			<p>Ask a question in English and get a response in Chinese and English.</p>
		</div>
	{:else}
		{#each convo.messages as message (message.id)}
			<ChatMessage {message} {showPinyin} />
		{/each}
	{/if}

	<!-- The in-flight message renders raw and updates per token; settled messages
	above render rich. While nothing has streamed yet, show the thinking bubble. -->
	{#if convo.streaming}
		<ChatMessage message={convo.streaming} {showPinyin} streaming />
	{:else if convo.isThinking}
		<Chat.Bubble variant="received">
			<Chat.BubbleMessage typing />
		</Chat.Bubble>
	{/if}

	{#if convo.error && !dismissedError}
		<div
			class="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive"
		>
			<span class="flex-1">{convo.error.message}</span>
			<Button size="sm" variant="outline" onclick={retry}>Retry</Button>
			<Button size="sm" variant="ghost" onclick={() => (dismissedError = true)}>
				✕
			</Button>
		</div>
	{/if}
</Chat.List>

<ChatInput
	bind:value={inputValue}
	isGenerating={convo.isGenerating}
	onSend={sendMessage}
	onStop={() => convo.stop()}
/>
