<script lang="ts">
	import FolderGrid from '$lib/components/FolderGrid.svelte';
	import { type FolderEntry, readFolder } from '$lib/model/folder';

	// v1: the sample vault is bundled at build time. The future #platform/fs seam
	// (Tauri fs / browser File System Access) replaces this with a live folder.
	const raw = import.meta.glob('/sample-vault/drafts/*.md', {
		query: '?raw',
		import: 'default',
		eager: true,
	}) as Record<string, string>;

	const entries: FolderEntry[] = Object.entries(raw).map(([path, content]) => ({
		path: path.split('/').pop() ?? path,
		content,
	}));

	const read = readFolder(entries);
</script>

<main class="flex h-screen flex-col">
	<FolderGrid {read} folder="sample-vault/drafts" />
</main>
