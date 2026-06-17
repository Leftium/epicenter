<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import LayersIcon from '@lucide/svelte/icons/layers';
	import { createVault } from '$lib/vault.svelte';
	import IntegrityPanel from './IntegrityPanel.svelte';
	import TablePane from './TablePane.svelte';

	let { root }: { root: string } = $props();

	// This keyed component IS the live vault for the active route: construct on mount, dispose on
	// destroy. The route's `{#key data.root}` tears this instance down and builds a fresh one when
	// the active vault changes, so the root watch AND every composed table watch ride this
	// component's lifetime, with no module singleton driving them.
	// svelte-ignore state_referenced_locally - the route keys this component on root, so it remounts (not re-renders) when the active vault changes; capturing the initial root here is the intent.
	const vault = createVault(root);
	$effect(() => () => vault.dispose());

	// Which table is active in the shell, held as the folder NAME (not the handle) so it survives a
	// reconcile that swaps handles. Defaults to the first table once the membership loads.
	let activeName = $state<string>();
	const activeTable = $derived(
		vault.tables.find((table) => table.folderName === activeName) ??
			vault.tables[0],
	);
</script>

<div class="flex min-h-0 flex-1 flex-col">
	{#await vault.whenReady}
		<Loading class="flex-1" label="Loading {vault.vaultName}" />
	{:then _}
		{#if vault.tables.length === 0}
			<Empty.Root class="flex-1 border-0">
				<Empty.Media variant="icon"><LayersIcon /></Empty.Media>
				<Empty.Title>No tables yet</Empty.Title>
				<Empty.Description>
					{vault.vaultName} has no table folders. Add a folder of markdown to it and it appears here.
				</Empty.Description>
			</Empty.Root>
		{:else}
			<div class="flex min-h-10 items-center gap-1 overflow-x-auto border-b px-2 py-1">
				{#each vault.tables as table (table.folderName)}
					{@const active = activeTable?.folderName === table.folderName}
					<button
						type="button"
						onclick={() => (activeName = table.folderName)}
						class={[
							'shrink-0 rounded-md px-2.5 py-1 text-sm transition',
							active
								? 'bg-muted font-medium text-foreground'
								: 'text-muted-foreground hover:bg-muted/50',
						]}
					>
						{table.folderName}
					</button>
				{/each}
			</div>
			{#if activeTable}
				{#key activeTable}
					<TablePane table={activeTable} />
				{/key}
			{/if}
			<IntegrityPanel integrity={vault.integrity} />
		{/if}
	{:catch error}
		<Empty.Root class="flex-1 border-0">
			<Empty.Media variant="icon"><FolderOpenIcon /></Empty.Media>
			<Empty.Title>Couldn't open {vault.vaultName}</Empty.Title>
			<Empty.Description>
				{error instanceof Error ? error.message : String(error)}
			</Empty.Description>
		</Empty.Root>
	{/await}
</div>
