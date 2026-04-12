<script lang="ts">
	import { page } from '$app/state';
	import { Button } from '@epicenter/ui/button';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import TableIcon from '@lucide/svelte/icons/table-2';
	import EntriesTable from '$lib/components/EntriesTable.svelte';
	import EntryTimeline from '$lib/components/EntryTimeline.svelte';
	import { entriesState } from '$lib/entries.svelte';
	import { viewState } from '$lib/view.svelte';

	const typeParam = $derived(decodeURIComponent(page.params.type ?? ''));
	const filteredEntries = $derived(
		entriesState.active.filter((e) => e.type.includes(typeParam)),
	);
</script>

<main class="flex h-full flex-1 flex-col overflow-hidden">
	<div class="flex items-center justify-between border-b px-4 py-2">
		<h2 class="text-sm font-semibold">{typeParam}</h2>
		<Button
			variant="ghost"
			size="icon"
			class="size-7"
			onclick={() => viewState.toggleViewMode()}
			title={viewState.viewMode === 'table' ? 'Switch to timeline' : 'Switch to table'}
		>
			{#if viewState.viewMode === 'table'}
				<ClockIcon class="size-4" />
			{:else}
				<TableIcon class="size-4" />
			{/if}
		</Button>
	</div>

	{#if viewState.viewMode === 'table'}
		<EntriesTable entries={filteredEntries} />
	{:else}
		<EntryTimeline entries={filteredEntries} />
	{/if}
</main>
