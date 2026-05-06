<script lang="ts">
	import EntriesTable from '$lib/components/EntriesTable.svelte';
	import EntriesTimeline from '$lib/components/EntriesTimeline.svelte';
	import { entriesState } from '$lib/entries-state.svelte';
	import { viewState } from '$lib/view-state.svelte';
</script>

{#if viewState.viewMode === 'table'}
	<EntriesTable entries={entriesState.active} />
{:else}
	<EntriesTimeline entries={entriesState.active} />
{/if}
