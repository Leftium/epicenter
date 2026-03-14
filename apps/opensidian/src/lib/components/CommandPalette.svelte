<script lang="ts">
	import type { FileId } from '@epicenter/filesystem';
	import * as Command from '@epicenter/ui/command';
	import {
		FileCode,
		File as FileIcon,
		FileJson,
		FileText,
	} from 'lucide-svelte';
	import { fsState } from '$lib/fs/fs-state.svelte';

	let open = $state(false);
	let searchQuery = $state('');
	let debouncedQuery = $state('');

	// ── Extension → icon mapping ─────────────────────────────────────
	const ICON_MAP: Record<string, typeof FileIcon> = {
		'.md': FileText,
		'.txt': FileText,
		'.ts': FileCode,
		'.js': FileCode,
		'.tsx': FileCode,
		'.jsx': FileCode,
		'.json': FileJson,
	};

	function getFileIcon(name: string): typeof FileIcon {
		const dotIndex = name.lastIndexOf('.');
		if (dotIndex === -1) return FileIcon;
		const ext = name.slice(dotIndex).toLowerCase();
		return ICON_MAP[ext] ?? FileIcon;
	}

	// ── Collect all files recursively (only when palette is open) ────
	type FileEntry = { id: FileId; name: string; parentDir: string };

	const allFiles = $derived.by((): FileEntry[] => {
		if (!open) return [];
		void fsState.version;

		const files: FileEntry[] = [];
		function collect(parentId: FileId | null) {
			for (const childId of fsState.getChildIds(parentId)) {
				const row = fsState.getRow(childId);
				if (!row) continue;
				if (row.type === 'file') {
					const fullPath = fsState.getPathForId(childId) ?? '';
					const lastSlash = fullPath.lastIndexOf('/');
					const parentDir = lastSlash > 0 ? fullPath.slice(1, lastSlash) : '';
					files.push({
						id: childId,
						name: row.name,
						parentDir,
					});
				} else if (row.type === 'folder') {
					collect(childId);
				}
			}
		}
		collect(null);
		return files;
	});

	// ── Debounce search input at 150ms ───────────────────────────────
	$effect(() => {
		const query = searchQuery;
		const timer = setTimeout(() => {
			debouncedQuery = query;
		}, 150);
		return () => clearTimeout(timer);
	});

	// ── Reset search when palette closes ─────────────────────────────
	$effect(() => {
		if (!open) {
			searchQuery = '';
			debouncedQuery = '';
		}
	});

	// ── Filtered results: startsWith first, then includes, cap 50 ───
	const filteredFiles = $derived.by(() => {
		const q = debouncedQuery.toLowerCase().trim();
		if (!q) return allFiles.slice(0, 50);

		const startsWith: FileEntry[] = [];
		const includes: FileEntry[] = [];

		for (const file of allFiles) {
			const name = file.name.toLowerCase();
			if (name.startsWith(q)) {
				startsWith.push(file);
			} else if (name.includes(q)) {
				includes.push(file);
			}
			if (startsWith.length + includes.length >= 50) break;
		}

		return [...startsWith, ...includes].slice(0, 50);
	});

	// ── Handlers ─────────────────────────────────────────────────────
	function handleSelect(id: FileId) {
		fsState.actions.selectFile(id);
		open = false;
	}

	function handleKeydown(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
			e.preventDefault();
			open = !open;
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<Command.Dialog
	bind:open
	title="Search Files"
	description="Search for a file by name"
	shouldFilter={false}
>
	<Command.Input placeholder="Search files..." bind:value={searchQuery} />
	<Command.List>
		<Command.Empty>No files found.</Command.Empty>
		<Command.Group heading="Files">
			{#each filteredFiles as file (file.id)}
				<Command.Item value={file.id} onSelect={() => handleSelect(file.id)}>
					{@const Icon = getFileIcon(file.name)}
					<Icon class="h-4 w-4 shrink-0 text-muted-foreground" />
					<span>{file.name}</span>
					{#if file.parentDir}
						<span class="ml-auto text-xs truncate text-muted-foreground">
							{file.parentDir}
						</span>
					{/if}
				</Command.Item>
			{/each}
		</Command.Group>
	</Command.List>
</Command.Dialog>
