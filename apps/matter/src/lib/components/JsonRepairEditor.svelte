<script lang="ts">
	import type { CellResult } from '$lib/model/conformance';
	import { createCellEdit } from './fields/create-cell-edit.svelte';
	import type { ClearField, SaveField } from './fields/types';

	// The universal repair editor for an INVALID cell, chosen by ModeledCell before
	// any per-kind Field. Edit the JSON-serialized value and re-parse on commit:
	// JSON (not the bare scalar) because at the type boundary explicit identity is
	// the point ("1240s" reads as a string, not a number) and it round-trips any
	// shape. Parsing GATES the save (a syntax error is held, never written); the
	// model never gates a write, so a still-invalid-but-parseable value saves and
	// stays INVALID. The row reclassifies through the watcher, so a now-valid value
	// snaps back to its typed Field on its own.
	let { cell, save, clear }: {
		cell: CellResult;
		save: SaveField;
		clear: ClearField;
	} = $props();

	const edit = createCellEdit({
		cell: () => cell,
		save: (value) => save(value),
		clear: () => clear(),
		display: (value) => JSON.stringify(value) ?? '',
		parse: (text) => {
			if (text.trim() === '') return { type: 'clear' };
			try {
				return { type: 'value', value: JSON.parse(text) };
			} catch {
				return { type: 'error', message: 'Not valid JSON' };
			}
		},
	});
</script>

{#if edit.editing}
	<input
		{@attach (node) => node.select()}
		bind:value={edit.draft}
		onblur={edit.commit}
		onkeydown={edit.onKeydown}
		class="w-full rounded border bg-background px-1 py-0.5 text-sm {edit.parseError
			? 'border-destructive'
			: ''}"
	/>
	{#if edit.parseError}
		<span class="mt-0.5 block text-xs text-destructive">{edit.parseError}</span>
	{/if}
{:else}
	<button
		type="button"
		onclick={edit.start}
		class="block w-full cursor-text text-left"
	>
		<code class="rounded bg-destructive/10 px-1 text-xs text-destructive"
			>{JSON.stringify(cell.value)}</code
		>
	</button>
{/if}
