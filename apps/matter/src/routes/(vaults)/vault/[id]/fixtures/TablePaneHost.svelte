<!--
	Test fixture: renders the active table's pane the way VaultShell does, keyed on
	the table so a switch remounts the pane, with one button per table standing in
	for the sidebar's table links. Not production UI.
-->
<script lang="ts">
	import * as Tooltip from '@epicenter/ui/tooltip';
	import type { VaultHandle } from '$lib/vault.svelte';
	import TablePane from '../TablePane.svelte';

	let { vault }: { vault: VaultHandle } = $props();

	let activeName = $state<string>();
	const activeTable = $derived(
		vault.tables.find((table) => table.folderName === activeName) ??
			vault.tables[0],
	);
</script>

<Tooltip.Provider>
	<nav>
		{#each vault.tables as table (table.folderName)}
			<button type="button" onclick={() => (activeName = table.folderName)}>
				Show {table.folderName}
			</button>
		{/each}
	</nav>
	{#if activeTable}
		{#key activeTable}
			<TablePane {vault} table={activeTable} />
		{/key}
	{/if}
</Tooltip.Provider>
