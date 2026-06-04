<script lang="ts">
	import FolderGrid from '$lib/components/FolderGrid.svelte';
	import { openVault, type Vault } from '$lib/vault.svelte';

	let vault = $state<Vault>();
	let opening = $state(false);
	let openError = $state<string>();

	async function openFolder() {
		opening = true;
		openError = undefined;
		try {
			const opened = await openVault();
			if (opened) vault = opened;
		} catch (error) {
			openError = error instanceof Error ? error.message : String(error);
		} finally {
			opening = false;
		}
	}
</script>

<main class="flex h-screen flex-col">
	<div class="flex items-center gap-3 border-b px-4 py-2">
		<button
			type="button"
			onclick={openFolder}
			disabled={opening}
			class="rounded border px-2 py-1 text-xs font-medium disabled:opacity-50"
		>
			{opening ? 'Opening...' : vault ? 'Open another folder' : 'Open folder'}
		</button>
		{#if vault}
			<span class="text-xs text-muted-foreground">{vault.name}</span>
		{/if}
		{#if openError}
			<span class="text-xs text-destructive">{openError}</span>
		{/if}
	</div>

	{#if vault}
		<FolderGrid read={vault.read} folder={vault.name} />
	{:else}
		<div class="flex flex-1 items-center justify-center">
			<p class="text-sm text-muted-foreground">
				Open a folder of markdown to begin.
			</p>
		</div>
	{/if}
</main>
