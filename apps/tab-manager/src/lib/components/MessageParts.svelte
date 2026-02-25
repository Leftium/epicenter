<script lang="ts">
	import { marked } from 'marked';
	import ToolCallPart from './ToolCallPart.svelte';
	import ToolResultPart from './ToolResultPart.svelte';
	import ThinkingPart from './ThinkingPart.svelte';
	import type {
		MessagePart,
		ToolCallPart as ToolCallPartType,
		ToolResultPart as ToolResultPartType,
	} from '@tanstack/ai-client';

	let {
		parts,
	}: {
		parts: MessagePart[];
	} = $props();

	function renderMarkdown(content: string): string {
		return marked.parse(content, { breaks: true, gfm: true }) as string;
	}
</script>

{#snippet mediaPart(label: string)}
	<div class="py-1 text-xs text-muted-foreground italic">{label}</div>
{/snippet}

{#each parts as part, i (i)}
	{#if part.type === 'text'}
		<div class="prose prose-sm">{@html renderMarkdown(part.content)}</div>
	{:else if part.type === 'tool-call'}
		<ToolCallPart part={part as ToolCallPartType} />
	{:else if part.type === 'tool-result'}
		<ToolResultPart part={part as ToolResultPartType} />
	{:else if part.type === 'thinking'}
		<ThinkingPart
			content={(part as { type: 'thinking'; content: string }).content}
		/>
	{:else if part.type === 'image'}
		{@render mediaPart('[Image content]')}
	{:else if part.type === 'audio'}
		{@render mediaPart('[Audio content]')}
	{:else if part.type === 'video'}
		{@render mediaPart('[Video content]')}
	{:else if part.type === 'document'}
		{@render mediaPart('[Document content]')}
	{/if}
{/each}
