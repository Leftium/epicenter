<script lang="ts">
	import type { ConversationId } from '@epicenter/chat';
	import { bindAgentConversation } from '@epicenter/svelte';
	import { Button } from '@epicenter/ui/button';
	import * as Chat from '@epicenter/ui/chat';
	import { generateMessageId, VOCAB_MODEL } from '@epicenter/vocab';
	import { createVocabEngine } from '@epicenter/vocab/engine';
	import { InstantString } from '@epicenter/workspace';
	import { createConversation as createAgentConversation } from '@epicenter/workspace/agent';
	import { onDestroy } from 'svelte';
	import { requireVocab } from '$lib/session';
	import { inferenceConnections } from '$lib/state/inference-connections.svelte';
	import ChatInput from './ChatInput.svelte';
	import ChatMessage from './ChatMessage.svelte';

	let {
		conversationId,
		model,
		showPinyin,
	}: { conversationId: ConversationId; model: string; showPinyin: boolean } =
		$props();

	const vocab = requireVocab();

	// The conversation's model (ADR-0055) resolves against this device's
	// connections. When no connection here serves it (a custom model set on another
	// device), the banner shows and sending is blocked; the synced model column is
	// never rewritten on detection, only by an explicit pick (ADR-0058).
	const isModelAvailable = $derived(inferenceConnections.resolve(model) !== null);

	// The component is keyed on conversationId, so it mounts fresh per
	// conversation: open the message store and bind it to the inference engine. The
	// engine reads the conversation model and device connections per turn, so a
	// header model switch lands on the next turn. Vocab is capability-free
	// (ADR-0047), so the loop runs with no tools: a single text step per turn.
	// svelte-ignore state_referenced_locally
	const convo = bindAgentConversation(
		createAgentConversation({
			store: vocab.tables.conversations.docs.messages.open(conversationId),
			engine: createVocabEngine({
				model: () => model,
				connections: inferenceConnections,
			}),
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

	/** Fall back to Vocab's always-available hosted model for this conversation. */
	function useHostedDefault() {
		vocab.tables.conversations.update(conversationId, {
			model: VOCAB_MODEL,
			updatedAt: InstantString.now(),
		});
	}
</script>

{#if !isModelAvailable}
	<div
		class="m-4 flex items-center gap-3 rounded-md border bg-muted/50 p-3 text-sm"
	>
		<span class="flex-1">
			This conversation uses
			<span class="font-mono">{model}</span>, set up on another device and not
			reachable here.
		</span>
		<Button size="sm" variant="outline" onclick={useHostedDefault}>
			Use Vocab's default
		</Button>
	</div>
{/if}

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
	disabled={!isModelAvailable}
	onSend={sendMessage}
	onStop={() => convo.stop()}
/>
