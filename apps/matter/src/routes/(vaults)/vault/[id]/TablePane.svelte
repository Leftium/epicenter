<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import FolderGrid from '$lib/components/FolderGrid.svelte';
	import type { TableHandle } from '$lib/table.svelte';
	import { createWhereFilter } from '$lib/where-filter.svelte';

	// One table of the active vault. The Vault constructs and disposes the table (it owns the
	// watcher lifetime); this pane just renders it. VaultShell keys this component on the active
	// table, so switching tables remounts the pane with a fresh filter and its own effect.
	let { table }: { table: TableHandle } = $props();

	// One WHERE filter per pane: it takes the table at construction and owns its own effect
	// (re-querying on a clause or mirror change, cancelling stale runs). The remount-per-table
	// keying is what makes "take the table at construction" safe.
	// svelte-ignore state_referenced_locally - VaultShell keys this pane on the active table, so it remounts (not re-renders) when the table changes; capturing the construction-time table is the intent.
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
