<script lang="ts">
	import { createCellEdit } from './create-cell-edit.svelte';
	import FieldEmpty from './FieldEmpty.svelte';
	import type { FieldProps } from './types';

	// Serves BOTH `number` and `integer`: parsing is identical (Number()), and the
	// integer-vs-float distinction is the SCHEMA's to enforce. A non-finite draft is
	// kept as the raw string so it persists as INVALID to fix, never silently dropped
	// (the model never gates a write); an integer field given 3.5 likewise classifies
	// INVALID and routes to the JSON repair editor on its next edit.
	let { cell, save }: FieldProps = $props();

	const edit = createCellEdit({
		cell: () => cell,
		save: (value) => save(value),
		display: (value) => (value == null ? '' : String(value)),
		parse: (text) => {
			if (text.trim() === '') return { type: 'clear' };
			const n = Number(text);
			return { type: 'value', value: Number.isFinite(n) ? n : text };
		},
	});

	const autofocus = (node: HTMLInputElement) => node.select();
</script>

{#if edit.editing}
	<input
		use:autofocus
		inputmode="decimal"
		bind:value={edit.draft}
		onblur={edit.commit}
		onkeydown={edit.onKeydown}
		class="w-full rounded border bg-background px-1 py-0.5 text-sm tabular-nums"
	/>
{:else}
	<button
		type="button"
		onclick={edit.start}
		class="block w-full cursor-text text-left"
	>
		{#if cell.value == null}
			<FieldEmpty state={cell.state} />
		{:else}
			<span class="tabular-nums">{String(cell.value)}</span>
		{/if}
	</button>
{/if}
