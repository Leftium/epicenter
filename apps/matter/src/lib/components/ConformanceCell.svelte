<script lang="ts">
	import type { CellResult } from '$lib/model/conformance';
	import type { DerivedKind } from '$lib/model/schema';

	// `derivedKind` (not `derived`) to avoid colliding with the `$derived` rune.
	let { cell, derivedKind }: { cell: CellResult; derivedKind: DerivedKind } =
		$props();
</script>

{#if cell.state === 'EMPTY'}
	<span class="text-muted-foreground/40">—</span>
{:else if cell.state === 'NEEDS_VALUE'}
	<span class="rounded bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-400">
		required
	</span>
{:else if cell.state === 'INVALID'}
	<!-- Widget floor: an out-of-domain value drops to raw text + a badge so it
	     stays editable until it validates, then snaps back to the typed widget. -->
	<code class="rounded bg-destructive/10 px-1 text-xs text-destructive">{String(cell.value)}</code>
{:else if derivedKind.kind === 'array' && Array.isArray(cell.value)}
	<div class="flex flex-wrap gap-1">
		{#each cell.value as item (item)}
			<span class="rounded bg-muted px-1.5 py-0.5 text-xs">{item}</span>
		{/each}
	</div>
{:else if derivedKind.kind === 'boolean'}
	<span class={cell.value ? 'text-foreground' : 'text-muted-foreground'}>
		{cell.value ? '✓' : '✗'}
	</span>
{:else if derivedKind.kind === 'url' && typeof cell.value === 'string'}
	<a href={cell.value} target="_blank" rel="noreferrer" class="text-primary underline underline-offset-2">
		{cell.value}
	</a>
{:else if derivedKind.kind === 'enum'}
	<span class="rounded bg-muted px-1.5 py-0.5 text-xs">{String(cell.value)}</span>
{:else if derivedKind.kind === 'number' || derivedKind.kind === 'integer'}
	<span class="tabular-nums">{String(cell.value)}</span>
{:else}
	<span class="truncate">{String(cell.value)}</span>
{/if}
