<script lang="ts">
	import { requireWorkspace } from '$lib/session.svelte';
	import EntriesTable from './components/EntriesTable.svelte';
	import EntriesTimeline from './components/EntriesTimeline.svelte';
	import { viewState } from './state/view.svelte';

	const workspace = requireWorkspace();
</script>

{#if viewState.viewMode === 'table'}
	<EntriesTable entries={workspace.entries.active} />
{:else}
	<EntriesTimeline entries={workspace.entries.active} />
{/if}
