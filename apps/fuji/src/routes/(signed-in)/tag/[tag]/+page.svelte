<script lang="ts">
	import { page } from '$app/state';
	import EntriesTable from '$lib/components/EntriesTable.svelte';
	import EntriesTimeline from '$lib/components/EntriesTimeline.svelte';
	import { getEntriesState } from '$lib/entries-state.svelte';
	import { viewState } from '$lib/view-state.svelte';

	const entriesState = getEntriesState();
	const tagParam = $derived(decodeURIComponent(page.params.tag ?? ''));
	const filteredEntries = $derived(
		entriesState.active.filter((e) => e.tags.includes(tagParam)),
	);
</script>

{#if viewState.viewMode === 'table'}
	<EntriesTable entries={filteredEntries} title={tagParam} />
{:else}
	<EntriesTimeline entries={filteredEntries} title={tagParam} />
{/if}
