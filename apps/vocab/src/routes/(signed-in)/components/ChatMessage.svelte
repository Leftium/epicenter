<script lang="ts">
	import * as Chat from '@epicenter/ui/chat';
	import { messageText, type VocabMessage } from '@epicenter/vocab';
	import AssistantMessagePart from './AssistantMessagePart.svelte';

	let {
		message,
		showPinyin,
	}: { message: VocabMessage; showPinyin: boolean } = $props();

	const isUser = $derived(message.role === 'user');
	const text = $derived(messageText(message));
</script>

<Chat.Bubble variant={isUser ? 'sent' : 'received'}>
	<Chat.BubbleMessage>
		<!-- Text-only by design: a vocab message holds text parts only, so the
			rendered body is their concatenation. -->
		{#if isUser}
			{text}
		{:else}
			<AssistantMessagePart content={text} {showPinyin} />
		{/if}
	</Chat.BubbleMessage>
</Chat.Bubble>
