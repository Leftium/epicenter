<script lang="ts">
	import EntriesListView from '$lib/components/EntriesListView.svelte';
	import { entriesState } from '$lib/entries.svelte';
</script>

<EntriesListView entries={entriesState.active} />
