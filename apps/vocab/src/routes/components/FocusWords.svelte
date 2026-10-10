<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { toast } from '@epicenter/ui/sonner';
	import { type Entry, type FocusItem, focusWord, STAGE_LABELS, STAGES, type Stage } from '$lib/data.js';
	import type { EntriesState } from '$lib/entries.svelte.js';

	let { focus, entries }: {
		focus: readonly FocusItem[];
		entries: EntriesState;
	} = $props();

	/** Press a stage of a saved word: the open word's draft, or the word as listed. */
	async function press(entry: Entry, stage: Stage) {
		const problem = await entries.setStage(entry, stage);
		if (problem) toast.error(problem);
	}
</script>

<h2 class="mb-3 text-sm font-semibold">Focus words</h2>
{#each focus as item (item.entryId)}
	{@const entry = focusWord(entries.entries, item)}
	<div class="mb-4">
		<p class="font-medium">{item.text}</p>
		{#if entry}
			{@const current = entries.fieldsOf(entry).stage}
			<div class="mt-1 flex flex-wrap gap-1" aria-label="Your stage for {item.text}">
				{#each STAGES as stage}
					<Button size="sm" variant={current === stage ? 'default' : 'outline'} aria-pressed={current === stage} disabled={entries.isLocked(entry.id)} onclick={() => press(entry, stage)}>{STAGE_LABELS[stage]}</Button>
				{/each}
			</div>
		{/if}
	</div>
{/each}
