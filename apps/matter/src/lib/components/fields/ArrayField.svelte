<script lang="ts">
	import { deriveKind } from '$lib/model/schema';
	import FieldEmpty from './FieldEmpty.svelte';
	import type { FieldProps } from './types';

	// Read-only chips for now: inline array EDITING is deferred (the spec), so a
	// click does not open an editor here. An INVALID array routes to the JSON repair
	// editor via the wrapper, where it is fully editable. The per-item kind is
	// derived once from the array's `items` schema, so a url[] renders link chips
	// and a string[] renders text chips instead of lossy stringified values.
	let { cell, field }: FieldProps = $props();

	const itemKind = $derived(
		deriveKind((field.schema as { items?: Record<string, unknown> }).items ?? {})
			.kind,
	);

	function chip(item: unknown): string {
		return typeof item === 'object' && item !== null
			? JSON.stringify(item)
			: String(item);
	}
</script>

{#if cell.value == null}
	<FieldEmpty state={cell.state} />
{:else if Array.isArray(cell.value)}
	<div class="flex flex-wrap gap-1">
		{#each cell.value as item, i (i)}
			{#if itemKind === 'url' && typeof item === 'string'}
				<a
					href={item}
					target="_blank"
					rel="noreferrer"
					class="rounded bg-muted px-1.5 py-0.5 text-xs text-primary underline"
					>{item}</a
				>
			{:else}
				<span class="rounded bg-muted px-1.5 py-0.5 text-xs">{chip(item)}</span>
			{/if}
		{/each}
	</div>
{:else}
	<!-- A VALID array cell is always an array; render defensively rather than crash. -->
	<span class="truncate">{chip(cell.value)}</span>
{/if}
