<script lang="ts">
	import { page } from '$app/state';
	import EntriesListView from '$lib/components/EntriesListView.svelte';
	import { entriesState } from '$lib/entries.svelte';

	const typeParam = $derived(decodeURIComponent(page.params.type ?? ''));
	const filteredEntries = $derived(
		entriesState.active.filter((e) => e.type.includes(typeParam)),
	);
</script>

<EntriesListView entries={filteredEntries} title={typeParam} />
