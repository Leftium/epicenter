<script lang="ts">
	import { fs } from '#platform/fs';
	import FolderGrid from '$lib/components/FolderGrid.svelte';
	import { type FolderEntry, type FolderRead, readFolder } from '$lib/model/folder';

	// The bundled sample vault is the zero-config first view; opening a real folder
	// through the #platform/fs seam (Tauri command / browser File System Access)
	// replaces it.
	const sampleRaw = import.meta.glob('/sample-vault/drafts/*.md', {
		query: '?raw',
		import: 'default',
		eager: true,
	}) as Record<string, string>;
	const sampleModel = import.meta.glob('/sample-vault/drafts/matter.json', {
		query: '?raw',
		import: 'default',
		eager: true,
	}) as Record<string, string>;
	const sampleEntries: FolderEntry[] = Object.entries(sampleRaw).map(
		([path, content]) => ({ path: path.split('/').pop() ?? path, content }),
	);

	let folder = $state('sample-vault/drafts');
	let read = $state<FolderRead>(
		readFolder(sampleEntries, Object.values(sampleModel)[0]),
	);
	let opening = $state(false);
	let openError = $state<string>();

	async function openFolder() {
		opening = true;
		openError = undefined;
		try {
			const opened = await fs.openFolder();
			if (!opened) return; // cancelled
			folder = opened.name;
			read = readFolder(opened.entries, opened.modelText);
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
			disabled={opening || !fs.available}
			class="rounded border px-2 py-1 text-xs font-medium disabled:opacity-50"
		>
			{opening ? 'Opening...' : 'Open folder'}
		</button>
		{#if !fs.available}
			<span class="text-xs text-muted-foreground">
				Folder opening needs the desktop app or a Chromium browser.
			</span>
		{:else if openError}
			<span class="text-xs text-destructive">{openError}</span>
		{/if}
	</div>
	<FolderGrid {read} {folder} />
</main>
