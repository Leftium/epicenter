<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import XIcon from '@lucide/svelte/icons/x';
	import FieldEmpty from './FieldEmpty.svelte';
	import type { FieldProps } from './field-props';

	// Free string chips: `tags` has NO option set (that is `multiSelect`), so this is
	// direct entry, not a combobox. Type + Enter appends; the X on a chip or Backspace on
	// an empty input removes. No schema read (there is nothing to enumerate), so it takes
	// the base `FieldProps`. Emptying the list CLEARS the key (NEEDS_VALUE is the palette's
	// only empty state, the same contract StringField follows for empty text), never `[]`.
	let { cell, save, clear }: FieldProps = $props();

	let draft = $state('');

	// An OK list cell is always an array; render each item through String() and default
	// empty for the NEEDS_VALUE cell.
	const values = $derived(
		cell.state === 'OK' && Array.isArray(cell.value)
			? cell.value.map((value) => String(value))
			: [],
	);

	function add(tag: string) {
		const trimmed = tag.trim();
		// No empty tags, no duplicates: a no-op append must not echo through the watcher.
		if (trimmed === '' || values.includes(trimmed)) return;
		save([...values, trimmed]);
	}

	function remove(tag: string) {
		const next = values.filter((value) => value !== tag);
		if (next.length === 0) clear();
		else save(next);
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && draft.trim() !== '') {
			event.preventDefault();
			add(draft);
			draft = '';
		} else if (event.key === 'Backspace' && draft === '' && values.length > 0) {
			remove(values[values.length - 1]!);
		}
	}
</script>

<div
	class="flex min-h-8 flex-wrap items-center gap-1 rounded-md border bg-background px-2 py-1 text-sm focus-within:ring-1 focus-within:ring-ring"
>
	{#if cell.state === 'NEEDS_VALUE'}
		<FieldEmpty />
	{/if}
	{#each values as tag (tag)}
		<Badge variant="secondary" class="max-w-[12rem] gap-1 pr-1">
			<span class="truncate">{tag}</span>
			<button
				type="button"
				class="-mr-0.5 shrink-0 rounded-full p-0.5 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
				aria-label={`Remove ${tag}`}
				onclick={() => remove(tag)}
			>
				<XIcon class="size-3" />
			</button>
		</Badge>
	{/each}
	<input
		type="text"
		class="min-w-16 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
		placeholder={cell.state === 'OK' && values.length === 0 ? 'Add tags...' : ''}
		bind:value={draft}
		onkeydown={onKeydown}
	/>
</div>
