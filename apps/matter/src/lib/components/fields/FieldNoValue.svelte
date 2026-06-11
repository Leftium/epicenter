<script lang="ts">
	import type { NoValueCell } from '$lib/core/conformance';

	let { cell }: { cell: NoValueCell } = $props();

	// The shared no-value indicator, rendered by every Field's no-value branch. It
	// reads the classified cell state, not schema policy: NEEDS_VALUE gets an attention
	// label, EMPTY gets quiet absence. INVALID is gated elsewhere and OK shows a value.
	//
	// The CELL already carries the amber ring + tint (FolderGrid's cellStateClass), so
	// the required label is plain colored text, not a second boxed badge stacked inside that ring:
	// one quiet label per empty cell instead of a wall of outlined pills on a sparse row.
	const needsValue = $derived(cell.state === 'NEEDS_VALUE');
</script>

{#if needsValue}
	<span class="text-xs font-medium text-amber-700 dark:text-amber-500">required</span>
{:else}
	<span class="text-muted-foreground/50">.</span>
{/if}
