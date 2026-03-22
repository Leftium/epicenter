<script lang="ts">
	import * as Chat from '@epicenter/ui/chat';
	import AssistantMessagePart from './AssistantMessagePart.svelte';
	import type { UIMessage } from '@tanstack/ai-client';

	type Props = {
		message: UIMessage;
		showPinyin: boolean;
		isStreaming?: boolean;
	};

	let { message, showPinyin, isStreaming = false }: Props = $props();

	const isUser = $derived(message.role === 'user');
</script>

<Chat.Bubble variant={isUser ? 'sent' : 'received'}>
	<Chat.BubbleMessage>
		{#each message.parts as part}
			{#if part.type === 'text'}
				{#if isUser}
					{part.content}
				{:else}
					<AssistantMessagePart content={part.content} {showPinyin} {isStreaming} />
				{/if}
			{/if}
		{/each}
	</Chat.BubbleMessage>
</Chat.Bubble>
