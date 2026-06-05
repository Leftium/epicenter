<script lang="ts">
	import { createCellEdit } from './create-cell-edit.svelte';
	import FieldEmpty from './FieldEmpty.svelte';
	import type { FieldProps } from './types';

	let { cell, save, clear }: FieldProps = $props();

	const edit = createCellEdit({
		cell: () => cell,
		save: (value) => save(value),
		clear: () => clear(),
		display: (value) => (value == null ? '' : String(value)),
		parse: (text) =>
			text.trim() === '' ? { type: 'clear' } : { type: 'value', value: text },
	});
</script>

{#if edit.editing}
	<input
		{@attach (node) => node.select()}
		type="url"
		bind:value={edit.draft}
		onblur={edit.commit}
		onkeydown={edit.onKeydown}
		class="w-full rounded border bg-background px-1 py-0.5 text-sm"
	/>
{:else if cell.value == null}
	<button
		type="button"
		onclick={edit.start}
		class="block w-full cursor-text text-left"
	>
		<FieldEmpty state={cell.state} />
	</button>
{:else}
	<!-- The value is a live link; a SEPARATE affordance opens the editor (siblings,
	     not a button wrapping an anchor), so clicking the URL navigates and never
	     traps you in edit mode. -->
	<span class="flex items-center gap-1">
		<a
			href={String(cell.value)}
			target="_blank"
			rel="noreferrer"
			class="truncate text-primary underline underline-offset-2"
			>{String(cell.value)}</a
		>
		<button
			type="button"
			onclick={edit.start}
			class="shrink-0 text-xs text-muted-foreground hover:text-foreground"
			title="Edit">edit</button
		>
	</span>
{/if}
