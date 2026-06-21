<script lang="ts">
	import * as Chat from '@epicenter/ui/chat';
	import type { VocabMessage } from '@epicenter/vocab';
	import AssistantMessagePart from './AssistantMessagePart.svelte';

	let {
		message,
		showPinyin,
	}: { message: VocabMessage; showPinyin: boolean } = $props();

	const isUser = $derived(message.role === 'user');
</script>

<Chat.Bubble variant={isUser ? 'sent' : 'received'}>
	<Chat.BubbleMessage>
		{#if isUser}
			{message.text}
		{:else}
			<AssistantMessagePart content={message.text} {showPinyin} />
		{/if}
	</Chat.BubbleMessage>
</Chat.Bubble>
