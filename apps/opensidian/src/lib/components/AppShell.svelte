<script lang="ts">
	import {
		CommandPalette,
		type CommandPaletteItem,
	} from '@epicenter/ui/command-palette';
	import * as Resizable from '@epicenter/ui/resizable';
	import { ScrollArea } from '@epicenter/ui/scroll-area';
	import { Toggle } from '@epicenter/ui/toggle';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import FileIcon from '@lucide/svelte/icons/file';
	import TextIcon from '@lucide/svelte/icons/text';
	import { auth } from '$lib/auth';
	import { getSignedInSession } from '$lib/session.svelte';
	import { getFileIcon } from '$lib/utils/file-icons';
	import AiChat from './chat/AiChat.svelte';
	import ContentPanel from './editor/ContentPanel.svelte';
	import StatusBar from './editor/StatusBar.svelte';
	import SidebarHeader from './SidebarHeader.svelte';
	import SearchPanel from './search/SearchPanel.svelte';
	import TerminalPanel from './terminal/TerminalPanel.svelte';
	import FileTree from './tree/FileTree.svelte';

	const signedIn = getSignedInSession();
	let paletteOpen = $state(false);
	let chatOpen = $state(false);

	// ── First-visit onboarding ──────────────────────────────────────
	// Only auto-seed for anonymous visitors. Authenticated users get
	// their data from sync. Seeding before sync finishes would create
	// duplicates (new CRDT IDs locally + old IDs from the server).
	let onboarded = false;
	$effect(() => {
		if (onboarded) return;
		if (signedIn.opensidian.state.fs.rootChildIds.length > 0) {
			onboarded = true;
			return;
		}
		if (auth.state.status === 'signed-in') {
			onboarded = true;
			return;
		}
		// Empty file tree plus anonymous: seed demo data, open terminal, show welcome.
		onboarded = true;
		signedIn.opensidian.state.sampleData.load().then(() => {
			const readme = signedIn.opensidian.state.fs.walkTree((id, row) => {
				if (row.type === 'file' && row.name === 'README.md')
					return { collect: id, descend: false };
				return { descend: true };
			});
			if (readme[0]) signedIn.opensidian.state.fs.selectFile(readme[0]);
		});
		signedIn.opensidian.state.terminal.show();
	});
	$effect(() => {
		if (!paletteOpen) signedIn.opensidian.state.search.reset();
	});

	const allFileItems = $derived.by((): CommandPaletteItem[] => {
		if (!paletteOpen || signedIn.opensidian.state.search.scope !== 'names')
			return [];
		return signedIn.opensidian.state.fs.walkTree<CommandPaletteItem>(
			(id, row) => {
				if (row.type === 'file') {
					const fullPath = signedIn.opensidian.state.fs.getPath(id) ?? '';
					const lastSlash = fullPath.lastIndexOf('/');
					const parentDir = lastSlash > 0 ? fullPath.slice(1, lastSlash) : '';
					return {
						collect: {
							id,
							label: row.name,
							description: parentDir || undefined,
							icon: getFileIcon(row.name),
							group: 'Files',
							onSelect: () => signedIn.opensidian.state.fs.selectFile(id),
						},
						descend: false,
					};
				}
				return { descend: true };
			},
		);
	});

	const paletteItems = $derived(
		signedIn.opensidian.state.search.shouldFilter
			? allFileItems
			: signedIn.opensidian.state.search.searchResults,
	);

	let searchPanelRef: ReturnType<typeof SearchPanel> | undefined = $state();
	let terminalRef: ReturnType<typeof TerminalPanel> | undefined = $state();
	let previousFocus: HTMLElement | null = $state(null);

	// Restore focus when terminal closes (covers both keyboard shortcut and X button).
	let wasOpen = false;
	$effect(() => {
		const isOpen = signedIn.opensidian.state.terminal.open;
		if (wasOpen && !isOpen) {
			previousFocus?.focus();
			previousFocus = null;
		}
		wasOpen = isOpen;
	});

	function handleKeydown(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'f') {
			e.preventDefault();
			if (signedIn.opensidian.state.sidebarSearch.leftPaneView === 'search') {
				signedIn.opensidian.state.sidebarSearch.closeSearch();
			} else {
				signedIn.opensidian.state.sidebarSearch.openSearch();
				requestAnimationFrame(() => searchPanelRef?.focusInput());
			}
		}

		if ((e.metaKey || e.ctrlKey) && e.key === '`') {
			e.preventDefault();
			if (!signedIn.opensidian.state.terminal.open) {
				previousFocus = document.activeElement as HTMLElement | null;
				signedIn.opensidian.state.terminal.toggle();
				requestAnimationFrame(() => terminalRef?.focus());
			} else {
				signedIn.opensidian.state.terminal.toggle();
			}
		}

		if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'l') {
			e.preventDefault();
			chatOpen = !chatOpen;
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="flex h-screen flex-col">
	<Resizable.PaneGroup direction="horizontal" class="flex-1">
		<Resizable.Pane defaultSize={25} minSize={15} maxSize={50}>
			<div class="flex h-full flex-col">
				<SidebarHeader />
				{#if signedIn.opensidian.state.sidebarSearch.leftPaneView === 'search'}
					<SearchPanel bind:this={searchPanelRef} />
				{:else}
					<ScrollArea class="flex-1">
						<div class="p-2"><FileTree /></div>
					</ScrollArea>
				{/if}
			</div>
		</Resizable.Pane>
		<Resizable.Handle withHandle />
		<Resizable.Pane defaultSize={chatOpen ? 45: 75}>
			<Resizable.PaneGroup direction="vertical">
				<Resizable.Pane
					defaultSize={signedIn.opensidian.state.terminal.open ? 55: 100}
					minSize={30}
				>
					<ContentPanel />
				</Resizable.Pane>
				{#if signedIn.opensidian.state.terminal.open}
					<Resizable.Handle withHandle />
					<Resizable.Pane defaultSize={45} minSize={15} maxSize={70}>
						<TerminalPanel bind:this={terminalRef} />
					</Resizable.Pane>
				{/if}
			</Resizable.PaneGroup>
		</Resizable.Pane>
		{#if chatOpen}
			<Resizable.Handle withHandle />
			<Resizable.Pane defaultSize={30} minSize={20} maxSize={50}>
				<AiChat />
			</Resizable.Pane>
		{/if}
	</Resizable.PaneGroup>
	<StatusBar bind:chatOpen />
	<CommandPalette
		items={paletteItems}
		bind:open={paletteOpen}
		bind:value={signedIn.opensidian.state.search.searchQuery}
		placeholder={signedIn.opensidian.state.search.scope === 'names' ? 'Search file names...': signedIn.opensidian.state.search.scope === 'content' ? 'Search content...': 'Search files...'}
		emptyMessage={signedIn.opensidian.state.search.scope === 'content' ? 'No content matches.': signedIn.opensidian.state.search.scope === 'both' ? 'No results.': 'No files found.'}
		title="Search Files"
		description="Search for files by name or content"
		shouldFilter={signedIn.opensidian.state.search.shouldFilter}
	>
		{#snippet inputEndContent()}
			<div class="flex items-center gap-0.5">
				<Tooltip.Root>
					<Tooltip.Trigger>
						{#snippet child({ props })}
							<Toggle
								size="sm"
								pressed={signedIn.opensidian.state.search.scope === 'names'}
								onPressedChange={(v) => { signedIn.opensidian.state.search.scope = v ? 'names': 'both'; }}
								aria-label="Names only"
								class="size-6 rounded-sm p-0"
								{...props}
							>
								<FileIcon class="size-3.5" />
							</Toggle>
						{/snippet}
					</Tooltip.Trigger>
					<Tooltip.Content>Names only</Tooltip.Content>
				</Tooltip.Root>
				<Tooltip.Root>
					<Tooltip.Trigger>
						{#snippet child({ props })}
							<Toggle
								size="sm"
								pressed={signedIn.opensidian.state.search.scope === 'content'}
								onPressedChange={(v) => { signedIn.opensidian.state.search.scope = v ? 'content': 'both'; }}
								aria-label="Content only"
								class="size-6 rounded-sm p-0"
								{...props}
							>
								<TextIcon class="size-3.5" />
							</Toggle>
						{/snippet}
					</Tooltip.Trigger>
					<Tooltip.Content>Content only</Tooltip.Content>
				</Tooltip.Root>
			</div>
		{/snippet}
	</CommandPalette>
</div>
