<script lang="ts">
	import { page } from '$app/state';
	import EntriesListView from '$lib/components/EntriesListView.svelte';
	import { entriesState } from '$lib/entries.svelte';

	const tagParam = $derived(decodeURIComponent(page.params.tag ?? ''));
	const filteredEntries = $derived(
		entriesState.active.filter((e) => e.tags.includes(tagParam)),
	);
</script>

<EntriesListView entries={filteredEntries} title={tagParam} />
