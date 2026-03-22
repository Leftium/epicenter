<script lang="ts">
	import * as Chat from '@epicenter/ui/chat';
	import { marked } from 'marked';
	import { annotateHtml } from '$lib/pinyin/annotate';
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
					<div class="prose prose-sm">
						{#if showPinyin}
							{@html annotateHtml(marked.parse(part.content, { breaks: true, gfm: true }) as string)}
						{:else}
							{@html marked.parse(part.content, { breaks: true, gfm: true })}
						{/if}
					</div>
				{/if}
			{/if}
		{/each}
	</Chat.BubbleMessage>
</Chat.Bubble>
