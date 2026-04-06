<script lang="ts">
	import {
		CommandPalette,
		type CommandPaletteItem,
	} from '@epicenter/ui/command-palette';
	import * as Resizable from '@epicenter/ui/resizable';
	import { ScrollArea } from '@epicenter/ui/scroll-area';
	import { fsState } from '$lib/state/fs-state.svelte';
	import {
		type SearchScope,
		searchState,
	} from '$lib/state/search-state.svelte';
	import { terminalState } from '$lib/state/terminal-state.svelte';
	import { getFileIcon } from '$lib/utils/file-icons';
	import ContentPanel from './editor/ContentPanel.svelte';
	import StatusBar from './editor/StatusBar.svelte';
	import Toolbar from './Toolbar.svelte';
	import TerminalPanel from './terminal/TerminalPanel.svelte';
	import FileTree from './tree/FileTree.svelte';

	let paletteOpen = $state(false);

	$effect(() => {
		if (!paletteOpen) searchState.reset();
	});

	const allFileItems = $derived.by((): CommandPaletteItem[] => {
		if (!paletteOpen || searchState.scope !== 'names') return [];
		return fsState.walkTree<CommandPaletteItem>((id, row) => {
			if (row.type === 'file') {
				const fullPath = fsState.getPath(id) ?? '';
				const lastSlash = fullPath.lastIndexOf('/');
				const parentDir = lastSlash > 0 ? fullPath.slice(1, lastSlash) : '';
				return {
					collect: {
						id,
						label: row.name,
						description: parentDir || undefined,
						icon: getFileIcon(row.name),
						group: 'Files',
						onSelect: () => fsState.selectFile(id),
					},
					descend: false,
				};
			}
			return { descend: true };
		});
	});

	const paletteItems = $derived(
		searchState.shouldFilter ? allFileItems : searchState.searchResults,
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
		items={paletteItems}
		bind:open={paletteOpen}
		bind:value={searchState.searchQuery}
		placeholder={searchState.scope === 'names' ? 'Search file names...' : 'Search files...'}
		emptyMessage={searchState.scope === 'content' ? 'No content matches.' : searchState.scope === 'both' ? 'No results.' : 'No files found.'}
		title="Search Files"
		description="Search for files by name or content"
		shouldFilter={searchState.shouldFilter}
	>
		{#snippet headerContent()}
			<div class="flex items-center gap-1 px-3 pb-2">
				{#each [['names', 'Names'], ['content', 'Content'], ['both', 'Both']] as [ value, label ]}
					<button
						type="button"
						class="rounded-md px-3 py-1 text-xs font-medium transition-colors {searchState.scope === value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}"
						onclick={() => { searchState.scope = value as SearchScope; }}
					>
						{label}
					</button>
				{/each}
			</div>
		{/snippet}
	</CommandPalette>
</div>
