<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import FolderGrid from '$lib/components/FolderGrid.svelte';
	import { createTable } from '$lib/table.svelte';
	import { createWhereFilter } from '$lib/where-filter.svelte';

	let { path }: { path: string } = $props();

	// This keyed component IS the live table for the active route: construct on mount,
	// dispose on destroy. The route's `{#key data.path}` tears this instance down and
	// builds a fresh one when the active folder changes, so the OS watcher's lifetime
	// rides the component's, with no session singleton driving it. (A Vault that composes
	// many tables is the next layer up; today the route opens one table per tab.)
	// svelte-ignore state_referenced_locally - the route keys this component on path, so it remounts (not re-renders) when the active folder changes; capturing the initial path here is the intent.
	const table = createTable(path);
	$effect(() => () => table.dispose());

	// One WHERE filter per tab: each open table gets its own clause. It takes the table at
	// construction and owns its own effect (re-querying on a clause or mirror change, cancelling
	// stale runs), so there is nothing to wire here. FolderGrid renders its input and rows.
	const filter = createWhereFilter(table);
</script>

<div class="flex min-h-0 flex-1 flex-col">
	{#await table.whenReady}
		<Loading class="flex-1" label="Loading {table.folderName}" />
	{:then _}
		{#if table.writeError}
			<Alert.Root variant="destructive" class="rounded-none border-x-0 border-t-0 py-2">
				<Alert.Description class="text-xs">
					Couldn't save: {table.writeError}
				</Alert.Description>
			</Alert.Root>
		{/if}
		<FolderGrid {table} {filter} />
	{:catch error}
		<Empty.Root class="flex-1 border-0">
			<Empty.Media variant="icon"><FolderOpenIcon /></Empty.Media>
			<Empty.Title>Couldn't watch {table.folderName}</Empty.Title>
			<Empty.Description>
				{error instanceof Error ? error.message : String(error)}
			</Empty.Description>
		</Empty.Root>
	{/await}
</div>
