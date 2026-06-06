<script lang="ts">
	import { createCellEdit } from './create-cell-edit.svelte';
	import FieldEmpty from './FieldEmpty.svelte';
	import type { FieldProps } from './field-props';

	// An empty draft reverts: an empty string is not a valid uri, and clearing the
	// key is the cell's chrome, not an emptied input here.
	let { cell, save }: FieldProps = $props();

	const edit = createCellEdit({
		current: () => (cell.state === 'OK' ? cell.value : undefined),
		save: (value) => save(value),
		parse: (text) =>
			text.trim() === '' ? { type: 'cancel' } : { type: 'value', value: text },
	});
</script>

{#if edit.editing}
	<input
		{@attach (node) => node.select()}
		type="url"
		bind:value={edit.draft}
		onblur={edit.commit}
		onkeydown={edit.onKeydown}
		class="w-full rounded border bg-background px-1 py-0.5 text-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
	/>
{:else if cell.state === 'NEEDS_VALUE'}
	<button
		type="button"
		onclick={edit.start}
		class="block w-full cursor-text rounded-sm px-1 py-0.5 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
	>
		<FieldEmpty />
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
			class="truncate rounded-sm text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
			>{String(cell.value)}</a
		>
		<button
			type="button"
			onclick={edit.start}
			class="shrink-0 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
			title="Edit">edit</button
		>
	</span>
{/if}
