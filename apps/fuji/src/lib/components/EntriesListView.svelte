<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import TableIcon from '@lucide/svelte/icons/table-2';
	import EntriesTable from '$lib/components/EntriesTable.svelte';
	import EntriesTimeline from '$lib/components/EntriesTimeline.svelte';
	import { viewState } from '$lib/entries.svelte';
	import type { Entry } from '$lib/workspace';

	let {
		entries,
		title,
	}: {
		entries: Entry[];
		title?: string;
	} = $props();
</script>

<main class="flex h-full flex-1 flex-col overflow-hidden">
	<div class="flex items-center justify-between border-b px-4 py-2">
		{#if title}
			<h2 class="text-sm font-semibold">{title}</h2>
		{:else}
			<div></div>
		{/if}
		<Button
			variant="ghost"
			size="icon"
			class="size-7"
			onclick={() => viewState.toggleViewMode()}
			title={viewState.viewMode === 'table' ? 'Switch to timeline' : 'Switch to table'}
		>
			{#if viewState.viewMode === 'table'}
				<ClockIcon class="size-4" />
			{:else}
				<TableIcon class="size-4" />
			{/if}
		</Button>
	</div>

	{#if viewState.viewMode === 'table'}
		<EntriesTable {entries} />
	{:else}
		<EntriesTimeline {entries} />
	{/if}
</main>
