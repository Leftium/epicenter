<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import WrenchIcon from '@lucide/svelte/icons/wrench';
	import type { ToolCallPart as TanStackToolCallPart } from '@tanstack/ai-client';
	import { type WorkspaceTools } from '$lib/workspace';
	import CollapsibleSection from '../CollapsibleSection.svelte';

	let {
		part,
	}: {
		part: TanStackToolCallPart<WorkspaceTools>;
	} = $props();

	const isRunning = $derived(part.output == null);
	const isFailed = $derived(
		typeof part.output === 'object' &&
			part.output !== null &&
			'error' in part.output,
	);
	const displayName = $derived(
		part.name.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()),
	);
	const badgeVariant = $derived.by(() => {
		if (isFailed) return 'status.failed';
		if (isRunning) return 'status.running';
		return 'status.completed';
	});
</script>

{#snippet codeBlock(text: string)}
	<pre
		class="mt-0.5 whitespace-pre-wrap break-all font-mono text-[11px]"
	>{text}</pre>
{/snippet}

<div class="flex flex-col gap-1 py-1">
	<div class="flex items-center gap-1.5">
		{#if isRunning}
			<LoaderCircleIcon class="size-3 animate-spin text-blue-500" />
		{:else}
			<WrenchIcon class="size-3 text-muted-foreground" />
		{/if}
		<Badge variant={badgeVariant}> {displayName}{isRunning ? '…' : ''} </Badge>
	</div>

	<CollapsibleSection label="Details" contentClass="bg-muted/50">
		{#if part.arguments}
			<div class="mb-1">
				<span class="font-medium text-muted-foreground">Arguments:</span>
				{@render codeBlock(part.arguments)}
			</div>
		{/if}
		{#if part.output != null}
			<div>
				<span class="font-medium text-muted-foreground">Result:</span>
				{@render codeBlock(
					typeof part.output === 'string'
						? part.output
						: JSON.stringify(part.output, null, 2),
				)}
			</div>
		{/if}
	</CollapsibleSection>
</div>
