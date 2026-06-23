<script lang="ts">
	import * as Chat from '@epicenter/ui/chat';
	import type { VocabMessage } from '@epicenter/vocab';
	import { agentMessageText } from '@epicenter/workspace/agent';
	import AssistantProse from './AssistantProse.svelte';

	let {
		message,
		showPinyin,
		streaming = false,
	}: { message: VocabMessage; showPinyin: boolean; streaming?: boolean } =
		$props();

	const isUser = $derived(message.role === 'user');
	// Vocab is capability-free, so a message is plain prose: its text parts.
	const text = $derived(agentMessageText(message));
</script>

<Chat.Bubble variant={isUser ? 'sent' : 'received'}>
	<Chat.BubbleMessage>
		{#if isUser || streaming}
			<!--
				Raw text while the answer streams (and for the user's own turn): the
				rich markdown + pinyin pass runs once the message settles, so the
				per-token re-parse never happens. `AssistantProse` mounts on settle.
			-->
			<div class="whitespace-pre-wrap">{text}</div>
		{:else}
			<AssistantProse content={text} {showPinyin} />
		{/if}
	</Chat.BubbleMessage>
</Chat.Bubble>
