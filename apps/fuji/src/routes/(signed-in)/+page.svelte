<script lang="ts">
	import { getSignedInSession } from '$lib/session.svelte';
	import EntriesTable from './components/EntriesTable.svelte';
	import EntriesTimeline from './components/EntriesTimeline.svelte';
	import { viewState } from './state/view.svelte';

	const signedIn = getSignedInSession();
</script>

{#if viewState.viewMode === 'table'}
	<EntriesTable entries={signedIn.entries.active} />
{:else}
	<EntriesTimeline entries={signedIn.entries.active} />
{/if}
