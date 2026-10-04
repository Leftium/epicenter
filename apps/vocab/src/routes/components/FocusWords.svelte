<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { toast } from '@epicenter/ui/sonner';
	import { type FocusItem, focusWord, STAGE_LABELS, STAGES } from '$lib/data.js';
	import type { EntriesState } from '$lib/entries.svelte.js';

	let { focus, entries }: {
		focus: readonly FocusItem[];
		entries: EntriesState;
	} = $props();

	function report(message: string | null) {
		if (message !== null) toast.error('Not saved', { description: message });
	}
</script>

<h2 class="mb-3 text-sm font-semibold">Focus words</h2>
{#each focus as item (item.entryId)}
	{@const entry = focusWord(entries.entries, item)}
	<div class="mb-4">
		<p class="font-medium">{item.text}</p>
		{#if entry}
			<!-- The same editor as the word's card: a note typed there is saved with this stage. -->
			{@const word = entries.word(entry.id)}
			{@const current = word.stage(entry.stage)}
			<div class="mt-1 flex flex-wrap gap-1" aria-label="Your stage for {item.text}">
				{#each STAGES as stage}
					<Button size="sm" variant={current === stage ? 'default' : 'outline'} aria-pressed={current === stage} disabled={word.gated} onclick={async () => report(await word.setStage(stage))}>{STAGE_LABELS[stage]}</Button>
				{/each}
			</div>
		{/if}
	</div>
{/each}
