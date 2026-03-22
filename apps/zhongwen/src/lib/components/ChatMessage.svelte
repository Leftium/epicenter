<script lang="ts">
	import * as Chat from '@epicenter/ui/chat';
	import PinyinText from './PinyinText.svelte';
	import type { UIMessage } from '@tanstack/ai-client';

	type Props = {
		message: UIMessage;
		showPinyin: boolean;
	};

	let { message, showPinyin }: Props = $props();

	const isUser = $derived(message.role === 'user');
</script>

<Chat.Bubble variant={isUser ? 'sent' : 'received'}>
	<Chat.BubbleMessage>
		{#each message.parts as part}
			{#if part.type === 'text'}
				{#if isUser}
					{part.content}
				{:else}
					<PinyinText text={part.content} {showPinyin} />
				{/if}
			{/if}
		{/each}
	</Chat.BubbleMessage>
</Chat.Bubble>
