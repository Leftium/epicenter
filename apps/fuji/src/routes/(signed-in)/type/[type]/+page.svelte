<script lang="ts">
	import { page } from '$app/state';
	import EntriesTable from '$lib/components/EntriesTable.svelte';
	import EntriesTimeline from '$lib/components/EntriesTimeline.svelte';
	import { entriesState } from '$lib/entries-state.svelte';
	import { viewState } from '$lib/view-state.svelte';

	const typeParam = $derived(decodeURIComponent(page.params.type ?? ''));
	const filteredEntries = $derived(
		entriesState.active.filter((e) => e.type.includes(typeParam)),
	);
</script>

{#if viewState.viewMode === 'table'}
	<EntriesTable entries={filteredEntries} title={typeParam} />
{:else}
	<EntriesTimeline entries={filteredEntries} title={typeParam} />
{/if}
