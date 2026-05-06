<script lang="ts">
	import EntriesTable from './components/EntriesTable.svelte';
	import EntriesTimeline from './components/EntriesTimeline.svelte';
	import { getEntriesState } from './state/entries.svelte';
	import { viewState } from './state/view.svelte';

	const entriesState = getEntriesState();
</script>

{#if viewState.viewMode === 'table'}
	<EntriesTable entries={entriesState.active} />
{:else}
	<EntriesTimeline entries={entriesState.active} />
{/if}
