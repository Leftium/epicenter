<script lang="ts">
	import type { MessagePart } from '@tanstack/ai-client';
	import DOMPurify from 'dompurify';
	import { marked } from 'marked';
	import ThinkingPart from './ThinkingPart.svelte';
	import ToolCallPart from './ToolCallPart.svelte';
	import ToolResultPart from './ToolResultPart.svelte';

	let {
		parts,
		onApproveToolCall,
		onDenyToolCall,
	}: {
		parts: MessagePart[];
		onApproveToolCall: (approvalId: string) => void;
		onDenyToolCall: (approvalId: string) => void;
	} = $props();

	/**
	 * Exhaustiveness guard for the template's part dispatch: `part` is `never`
	 * only while every member of `MessagePart` has a branch above the
	 * `{:else}`, so a new part type in TanStack AI becomes a type error here.
	 *
	 * The branch is still reachable at runtime: parts round-trip through
	 * Y.Doc, so a newer build of this extension can persist part types this
	 * build does not know about.
	 */
	function unknownPartType(part: never): string {
		return (part as { type: string }).type;
	}
</script>

{#snippet mediaPart(label: string)}
	<div class="py-1 text-xs text-muted-foreground italic">{label}</div>
{/snippet}

{#each parts as part, i (`${part.type}-${i}`)}
	{#if part.type === 'text'}
		<div class="prose prose-sm">
			{@html DOMPurify.sanitize(marked.parse(part.content, { breaks: true, gfm: true }) as string)}
		</div>
	{:else if part.type === 'tool-call'}
		<ToolCallPart {part} {onApproveToolCall} {onDenyToolCall} />
	{:else if part.type === 'tool-result'}
		<ToolResultPart {part} />
	{:else if part.type === 'thinking'}
		<ThinkingPart content={part.content} />
	{:else if part.type === 'image'}
		{@render mediaPart('[Image content]')}
	{:else if part.type === 'audio'}
		{@render mediaPart('[Audio content]')}
	{:else if part.type === 'video'}
		{@render mediaPart('[Video content]')}
	{:else if part.type === 'document'}
		{@render mediaPart('[Document content]')}
	{:else if part.type === 'structured-output'}
		<!-- Only produced when createChat is given an outputSchema, which this
			app never sets. Persisted parts from a future build could carry it. -->
		{@render mediaPart('[Structured output]')}
	{:else}
		{@render mediaPart(`[Unsupported part: ${unknownPartType(part)}]`)}
	{/if}
{/each}
