<script lang="ts">
	import type { ColumnKind } from '$lib/model/types';

	let { value, kind, array }: { value: unknown; kind: ColumnKind; array: boolean } =
		$props();
</script>

{#if value === null || value === undefined}
	<span class="text-muted-foreground/50">—</span>
{:else if array && Array.isArray(value)}
	<div class="flex flex-wrap gap-1">
		{#each value as item (item)}
			<span class="rounded bg-muted px-1.5 py-0.5 text-xs">{item}</span>
		{/each}
	</div>
{:else if typeof value === 'object'}
	<code class="text-xs text-muted-foreground">{JSON.stringify(value)}</code>
{:else if kind === 'boolean'}
	<span class={value ? 'text-foreground' : 'text-muted-foreground'}>{value ? '✓' : '✗'}</span>
{:else if kind === 'url' && typeof value === 'string'}
	<a href={value} target="_blank" rel="noreferrer" class="text-primary underline underline-offset-2">
		{value}
	</a>
{:else if kind === 'number' || kind === 'integer'}
	<span class="tabular-nums">{String(value)}</span>
{:else}
	<span class="truncate">{String(value)}</span>
{/if}
