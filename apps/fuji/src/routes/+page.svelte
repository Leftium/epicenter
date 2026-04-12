<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import TableIcon from '@lucide/svelte/icons/table-2';
	import EntriesTable from '$lib/components/EntriesTable.svelte';
	import EntryTimeline from '$lib/components/EntryTimeline.svelte';
	import { entriesState } from '$lib/entries.svelte';
	import { viewState } from '$lib/view.svelte';

	/** Entries filtered by sidebar type/tag filters. */
	const filteredEntries = $derived.by(() => {
		let result = entriesState.active;
		const typeFilter = viewState.activeTypeFilter;
		const tagFilter = viewState.activeTagFilter;
		if (typeFilter) {
			result = result.filter((e) => e.type.includes(typeFilter));
		}
		if (tagFilter) {
			result = result.filter((e) => e.tags.includes(tagFilter));
		}
		return result;
	});
</script>

<main class="flex h-full flex-1 flex-col overflow-hidden">
	<!-- View mode toggle header -->
	<div class="flex items-center justify-end border-b px-4 py-2">
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
