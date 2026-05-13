<script lang="ts">
	import { requireApp } from '$lib/session';
	import EntriesTable from './components/EntriesTable.svelte';
	import EntriesTimeline from './components/EntriesTimeline.svelte';
	import { viewState } from './state/view.svelte';

	const app = requireApp();
</script>

{#if viewState.viewMode === 'table'}
	<EntriesTable entries={app.entries.active} />
{:else}
	<EntriesTimeline entries={app.entries.active} />
{/if}
