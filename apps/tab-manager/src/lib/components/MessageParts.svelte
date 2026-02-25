<script lang="ts">
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
</script>

{#each parts as part (part)}
	{#if part.type === 'text'}
		<div class="prose prose-sm">{part.content}</div>
	{:else if part.type === 'tool-call'}
		<ToolCallPart part={part as ToolCallPartType} />
	{:else if part.type === 'tool-result'}
		<ToolResultPart part={part as ToolResultPartType} />
	{:else if part.type === 'thinking'}
		<ThinkingPart content={(part as { type: 'thinking'; content: string }).content} />
	{:else if part.type === 'image'}
		<div class="py-1 text-xs text-muted-foreground italic">[Image content]</div>
	{:else if part.type === 'audio'}
		<div class="py-1 text-xs text-muted-foreground italic">[Audio content]</div>
	{:else if part.type === 'video'}
		<div class="py-1 text-xs text-muted-foreground italic">[Video content]</div>
	{:else if part.type === 'document'}
		<div class="py-1 text-xs text-muted-foreground italic">
			[Document content]
		</div>
	{/if}
{/each}
