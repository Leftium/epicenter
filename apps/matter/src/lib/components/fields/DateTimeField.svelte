<script lang="ts">
	import { createCellEdit } from './create-cell-edit.svelte';
	import FieldEmpty from './FieldEmpty.svelte';
	import type { FieldProps } from './types';

	// A text input over the RFC 3339 string for now; a NaturalLanguageDateInput
	// picker lands with the calendar view (spec "Later"). This Field is the seam
	// for that picker. A value that is not valid RFC 3339 classifies INVALID and
	// routes to the JSON repair editor, so this only ever sees a parseable instant.
	let { cell, save }: FieldProps = $props();

	const edit = createCellEdit({
		cell: () => cell,
		save: (value) => save(value),
		display: (value) => (value == null ? '' : String(value)),
		parse: (text) =>
			text.trim() === '' ? { type: 'clear' } : { type: 'value', value: text },
	});

	const autofocus = (node: HTMLInputElement) => node.select();
</script>

{#if edit.editing}
	<input
		use:autofocus
		bind:value={edit.draft}
		onblur={edit.commit}
		onkeydown={edit.onKeydown}
		class="w-full rounded border bg-background px-1 py-0.5 text-sm"
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
