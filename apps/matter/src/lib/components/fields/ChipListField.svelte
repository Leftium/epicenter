<script lang="ts">
	import FieldEmpty from './FieldEmpty.svelte';
	import type { FieldProps } from './types';

	// Read-only string chips, shared by `tags` (free strings) and `multiSelect`
	// (a closed enum set). Both at-rest shapes are an array of strings, so the
	// display is identical; inline EDITING is deferred (the spec), and an INVALID
	// value routes to the JSON repair editor via the wrapper, never here. The
	// editors will fork later (free chip entry for tags, a bounded picker for
	// multiSelect, whose options come from `optionsOf(field)`), at which point
	// this splits, the same way NumericField will if number and integer diverge.
	let { cell }: FieldProps = $props();
</script>

{#if cell.value == null}
	<FieldEmpty />
{:else if Array.isArray(cell.value)}
	<div class="flex flex-wrap gap-1">
		{#each cell.value as item, i (i)}
			<span class="rounded bg-muted px-1.5 py-0.5 text-xs">{String(item)}</span>
		{/each}
	</div>
{:else}
	<!-- A VALID list cell is always an array; render defensively rather than crash. -->
	<span class="truncate">{String(cell.value)}</span>
{/if}
