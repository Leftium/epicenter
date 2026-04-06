<script lang="ts">
	import * as Resizable from '@epicenter/ui/resizable';
	import { ScrollArea } from '@epicenter/ui/scroll-area';
	import { CommandPalette, type CommandPaletteItem } from '@epicenter/ui/command-palette';
	import type { FileId } from '@epicenter/filesystem';
	import { terminalState } from '$lib/state/terminal-state.svelte';
	import { fsState } from '$lib/state/fs-state.svelte';
	import { getFileIcon } from '$lib/utils/file-icons';
	import ContentPanel from './editor/ContentPanel.svelte';
	import Toolbar from './Toolbar.svelte';
	import TerminalPanel from './terminal/TerminalPanel.svelte';
	import FileTree from './tree/FileTree.svelte';
	import StatusBar from './editor/StatusBar.svelte';

	let paletteOpen = $state(false);

	// \u2500\u2500 Collect all files recursively (only when palette is open) \u2500\u2500\u2500\u2500
	type FileEntry = { id: FileId; name: string; parentDir: string };

	const allFiles = $derived.by((): FileEntry[] => {
		if (!paletteOpen) return [];
		return fsState.walkTree<FileEntry>((id, row) => {
			if (row.type === 'file') {
				const fullPath = fsState.getPath(id) ?? '';
				const lastSlash = fullPath.lastIndexOf('/');
				const parentDir = lastSlash > 0 ? fullPath.slice(1, lastSlash) : '';
				return { collect: { id, name: row.name, parentDir }, descend: false };
			}
			return { descend: true };
		});
	});

	const fileItems = $derived<CommandPaletteItem[]>(
		allFiles.map((file) => ({
			id: file.id,
			label: file.name,
			description: file.parentDir || undefined,
			icon: getFileIcon(file.name),
			group: 'Files',
			onSelect: () => fsState.selectFile(file.id),
		})),
	);

	let terminalRef: ReturnType<typeof TerminalPanel> | undefined = $state();
	let previousFocus: HTMLElement | null = $state(null);

	// Restore focus when terminal closes (covers both keyboard shortcut and X button).
	let wasOpen = false;
	$effect(() => {
		const isOpen = terminalState.open;
		if (wasOpen && !isOpen) {
			previousFocus?.focus();
			previousFocus = null;
		}
		wasOpen = isOpen;
	});

	function handleKeydown(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key === '`') {
			e.preventDefault();
			if (!terminalState.open) {
				previousFocus = document.activeElement as HTMLElement | null;
				terminalState.toggle();
				requestAnimationFrame(() => terminalRef?.focus());
			} else {
				terminalState.toggle();
			}
		}
	}

</script>

<svelte:window onkeydown={handleKeydown} />

<div class="flex h-screen flex-col">
	<Toolbar />
	<Resizable.PaneGroup direction="horizontal" class="flex-1">
		<Resizable.Pane defaultSize={25} minSize={15} maxSize={50}>
			<ScrollArea class="h-full">
				<div class="p-2"><FileTree /></div>
			</ScrollArea>
		</Resizable.Pane>
		<Resizable.Handle withHandle />
		<Resizable.Pane defaultSize={75}>
			<Resizable.PaneGroup direction="vertical">
				<Resizable.Pane
					defaultSize={terminalState.open ? 70 : 100}
					minSize={30}
				>
					<ContentPanel />
				</Resizable.Pane>
				{#if terminalState.open}
					<Resizable.Handle withHandle />
					<Resizable.Pane defaultSize={30} minSize={10} maxSize={60}>
						<TerminalPanel bind:this={terminalRef} />
					</Resizable.Pane>
				{/if}
			</Resizable.PaneGroup>
		</Resizable.Pane>
	</Resizable.PaneGroup>
	<StatusBar />
	<CommandPalette
		items={fileItems}
		bind:open={paletteOpen}
		placeholder="Search files..."
		emptyMessage="No files found."
		title="Search Files"
		description="Search for a file by name"
	/>
</div>

