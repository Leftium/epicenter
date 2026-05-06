<script lang="ts">
	import EntriesTable from '$lib/components/EntriesTable.svelte';
	import EntriesTimeline from '$lib/components/EntriesTimeline.svelte';
	import { getEntriesState } from '$lib/entries-state.svelte';
	import { viewState } from '$lib/view-state.svelte';

	const entriesState = getEntriesState();
</script>

{#if viewState.viewMode === 'table'}
	<EntriesTable entries={entriesState.active} />
{:else}
	<EntriesTimeline entries={entriesState.active} />
{/if}
