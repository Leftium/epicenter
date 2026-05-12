<script lang="ts">
	import { page } from '$app/state';
	import { requireWorkspace } from '$lib/session.svelte';
	import EntriesTable from '../../components/EntriesTable.svelte';
	import EntriesTimeline from '../../components/EntriesTimeline.svelte';
	import { viewState } from '../../state/view.svelte';

	const workspace = requireWorkspace();
	const tagParam = $derived(decodeURIComponent(page.params.tag ?? ''));
	const filteredEntries = $derived(
		workspace.entries.active.filter((e) => e.tags.includes(tagParam)),
	);
</script>

{#if viewState.viewMode === 'table'}
	<EntriesTable entries={filteredEntries} title={tagParam} />
{:else}
	<EntriesTimeline entries={filteredEntries} title={tagParam} />
{/if}
