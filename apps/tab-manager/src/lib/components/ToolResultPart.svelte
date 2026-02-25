<script lang="ts">
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import AlertCircleIcon from '@lucide/svelte/icons/circle-alert';
	import type { ToolResultPart as TanStackToolResultPart } from '@tanstack/ai-client';

	let {
		part,
	}: {
		part: TanStackToolResultPart;
	} = $props();
</script>

<div class="py-1">
	{#if part.state === 'streaming'}
		<div class="flex items-center gap-1.5 text-xs text-muted-foreground">
			<LoaderCircleIcon class="size-3 animate-spin" />
			Processing…
		</div>
	{:else if part.state === 'error'}
		<div
			class="flex items-center gap-1.5 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
		>
			<AlertCircleIcon class="size-3 shrink-0" />
			<span>{part.error ?? 'Tool execution failed'}</span>
		</div>
	{:else}
		<div class="text-xs text-muted-foreground">
			{part.content}
		</div>
	{/if}
</div>
