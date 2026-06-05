<script lang="ts">
	import type { CellResult } from '$lib/model/conformance';
	import { createCellEdit, type CellEditParse } from './create-cell-edit.svelte';
	import FieldEmpty from './FieldEmpty.svelte';
	import type { SaveField } from './types';

	// The shared shell for the plain-text cell kinds (string, numeric, datetime):
	// click to open one text input, commit on blur/Enter, revert on Escape, with the
	// value always shown through String(). Those kinds differ ONLY in how a draft
	// PARSES (a number coerces; a string is verbatim) and in formatting CLASSES
	// (tabular digits vs truncated text), so those are the only props. Kinds with a
	// different non-editing display (url's link, json's repair code) keep their own
	// template and call createCellEdit directly; this shell is the common case, not
	// a universal cell.
	let {
		cell,
		save,
		parse,
		inputClass = '',
		displayClass = 'truncate',
		inputmode,
	}: {
		cell: CellResult;
		save: SaveField;
		/** Interpret the draft on commit (the one thing the text kinds differ on). */
		parse: (draft: string) => CellEditParse;
		/** Extra class for the open input (e.g. tabular digits). */
		inputClass?: string;
		/** Class for the non-editing value (e.g. truncate, tabular digits). */
		displayClass?: string;
		inputmode?: 'decimal';
	} = $props();

	// `cell`/`save`/`parse` are read through closures so the edit captures the
	// current prop, not its initial value (the same getter contract createCellEdit
	// already requires for `cell`).
	const edit = createCellEdit({
		cell: () => cell,
		save: (value) => save(value),
		display: (value) => (value == null ? '' : String(value)),
		parse: (draft) => parse(draft),
	});
</script>

{#if edit.editing}
	<input
		{@attach (node) => node.select()}
		{inputmode}
		bind:value={edit.draft}
		onblur={edit.commit}
		onkeydown={edit.onKeydown}
		class="w-full rounded border bg-background px-1 py-0.5 text-sm {inputClass}"
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
			<span class={displayClass}>{String(cell.value)}</span>
		{/if}
	</button>
{/if}
