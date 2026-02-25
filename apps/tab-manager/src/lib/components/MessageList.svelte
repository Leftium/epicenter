<script lang="ts">
	import * as Chat from '@epicenter/ui/chat';
	import * as Empty from '@epicenter/ui/empty';
	import { Button } from '@epicenter/ui/button';
	import MessageParts from './MessageParts.svelte';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import type { UIMessage } from '@tanstack/ai-svelte';

	let {
		messages,
		status,
		onReload,
	}: {
		messages: UIMessage[];
		status: 'ready' | 'submitted' | 'streaming' | 'error';
		onReload: () => void;
	} = $props();

	/**
	 * Show loading dots when waiting for assistant content.
	 *
	 * Covers the gap between 'submitted' (request sent) and first visible
	 * assistant token. Without this, dots flash away when status transitions
	 * to 'streaming' before any text is actually rendered.
	 */
	const showLoadingDots = $derived(
		status === 'submitted' ||
			(status === 'streaming' && messages.at(-1)?.role !== 'assistant'),
	);

	/** Show regenerate button when idle and last message is from assistant. */
	const showRegenerate = $derived(
		status === 'ready' && messages.at(-1)?.role === 'assistant',
	);
</script>

{#if messages.length === 0}
	<Empty.Root class="py-12">
		<Empty.Media>
			<SparklesIcon class="size-8 text-muted-foreground" />
		</Empty.Media>
		<Empty.Title>AI Chat</Empty.Title>
		<Empty.Description>
			Send a message to start chatting
		</Empty.Description>
	</Empty.Root>
{:else}
	<Chat.List>
		{#each messages as message (message.id)}
			<Chat.Bubble variant={message.role === 'user' ? 'sent' : 'received'}>
				<Chat.BubbleMessage>
					<MessageParts parts={message.parts} />
				</Chat.BubbleMessage>
			</Chat.Bubble>
		{/each}
		{#if showLoadingDots}
			<Chat.Bubble variant="received">
				<Chat.BubbleMessage typing />
			</Chat.Bubble>
		{/if}
		{#if showRegenerate}
			<div class="flex justify-start px-2 py-1">
				<Button
					variant="ghost"
					class="text-muted-foreground"
					onclick={onReload}
				>
					<RotateCcwIcon class="size-3" />
					Regenerate
				</Button>
			</div>
		{/if}
	</Chat.List>
{/if}
