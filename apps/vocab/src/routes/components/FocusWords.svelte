<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { toast } from '@epicenter/ui/sonner';
	import { onDestroy } from 'svelte';
	import { type FocusItem, focusWord, STAGE_LABELS, STAGES, type Stage } from '$lib/data.js';
	import type { EntriesState } from '$lib/entries.svelte.js';

	let { focus, entries }: {
		focus: readonly FocusItem[];
		entries: EntriesState;
	} = $props();

	/** Cleared on destroy: a button's listener outlives this list on a retained element. */
	let mounted = true;
	onDestroy(() => {
		mounted = false;
	});

	/** Press a stage of the word with this ID, resolved when pressed, only while its fields are its view. */
	async function press(id: string, stage: Stage) {
		const word = entries.word(id);
		if (!mounted || !word.stageable) return;
		// The message says what happened, refused or unknown; no title guesses.
		const message = await word.setStage(stage);
		if (message !== null) toast.error(message);
	}
</script>

<h2 class="mb-3 text-sm font-semibold">Focus words</h2>
{#each focus as item (item.entryId)}
	{@const entry = focusWord(entries.entries, item)}
	<div class="mb-4">
		<p class="font-medium">{item.text}</p>
		{#if entry}
			<!-- The same editor as the word's card: a stage saves the whole word, note as typed there included. -->
			{@const word = entries.word(entry.id)}
			{@const current = word.stage()}
			<div class="mt-1 flex flex-wrap gap-1" aria-label="Your stage for {item.text}">
				{#each STAGES as stage}
					<Button size="sm" variant={current === stage ? 'default' : 'outline'} aria-pressed={current === stage} disabled={!word.stageable} onclick={() => press(entry.id, stage)}>{STAGE_LABELS[stage]}</Button>
				{/each}
			</div>
		{/if}
	</div>
{/each}
