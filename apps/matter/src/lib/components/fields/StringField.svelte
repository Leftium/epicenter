<script lang="ts">
	import { createCellEdit } from './create-cell-edit.svelte';
	import type { FieldProps } from './types';

	let { cell, save }: FieldProps = $props();

	// The widget floor: a plain text input over the raw string. Empty clears the
	// field (delete the key); any non-empty text saves verbatim. `string` is the
	// always-valid base kind, so the draft never fails to parse.
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
		{#if cell.state === 'NEEDS_VALUE'}
			<span
				class="rounded bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-400"
				>required</span
			>
		{:else if cell.value == null}
			<span class="text-muted-foreground/40">·</span>
		{:else}
			<span class="truncate">{String(cell.value)}</span>
		{/if}
	</button>
{/if}
