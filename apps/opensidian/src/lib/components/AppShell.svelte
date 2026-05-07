<script lang="ts">
	import { CommandPalette } from '@epicenter/ui/command-palette';
	import * as Resizable from '@epicenter/ui/resizable';
	import { ScrollArea } from '@epicenter/ui/scroll-area';
	import { Toggle } from '@epicenter/ui/toggle';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import FileIcon from '@lucide/svelte/icons/file';
	import TextIcon from '@lucide/svelte/icons/text';
	import { getSignedInSession } from '$lib/session.svelte';
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

	$effect(() => {
		if (!paletteOpen) signedIn.state.paletteSearch.reset();
	});

	let searchPanelRef: ReturnType<typeof SearchPanel> | undefined = $state();
	let terminalRef: ReturnType<typeof TerminalPanel> | undefined = $state();
	let previousFocus: HTMLElement | null = $state(null);

	// Restore focus when terminal closes (covers both keyboard shortcut and X button).
	let wasOpen = false;
	$effect(() => {
		const isOpen = signedIn.state.terminal.open;
		if (wasOpen && !isOpen) {
			previousFocus?.focus();
			previousFocus = null;
		}
		wasOpen = isOpen;
	});

	function handleKeydown(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'f') {
			e.preventDefault();
			if (signedIn.state.sidebarSearch.leftPaneView === 'search') {
				signedIn.state.sidebarSearch.closeSearch();
			} else {
				signedIn.state.sidebarSearch.openSearch();
				requestAnimationFrame(() => searchPanelRef?.focusInput());
			}
		}

		if ((e.metaKey || e.ctrlKey) && e.key === '`') {
			e.preventDefault();
			if (!signedIn.state.terminal.open) {
				previousFocus = document.activeElement as HTMLElement | null;
				signedIn.state.terminal.toggle();
				requestAnimationFrame(() => terminalRef?.focus());
			} else {
				signedIn.state.terminal.toggle();
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
				{#if signedIn.state.sidebarSearch.leftPaneView === 'search'}
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
					defaultSize={signedIn.state.terminal.open ? 55: 100}
					minSize={30}
				>
					<ContentPanel />
				</Resizable.Pane>
				{#if signedIn.state.terminal.open}
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
		items={signedIn.state.paletteSearch.searchResults}
		bind:open={paletteOpen}
		bind:value={signedIn.state.paletteSearch.searchQuery}
		placeholder={signedIn.state.paletteSearch.scope === 'names' ? 'Search file names...': signedIn.state.paletteSearch.scope === 'content' ? 'Search content...': 'Search files...'}
		emptyMessage={signedIn.state.paletteSearch.scope === 'content' ? 'No content matches.': signedIn.state.paletteSearch.scope === 'both' ? 'No results.': 'No files found.'}
		title="Search Files"
		description="Search for files by name or content"
		shouldFilter={signedIn.state.paletteSearch.shouldFilter}
	>
		{#snippet inputEndContent()}
			<div class="flex items-center gap-0.5">
				<Tooltip.Root>
					<Tooltip.Trigger>
						{#snippet child({ props })}
							<Toggle
								size="sm"
								pressed={signedIn.state.paletteSearch.scope === 'names'}
								onPressedChange={(v) => { signedIn.state.paletteSearch.scope = v ? 'names': 'both'; }}
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
								pressed={signedIn.state.paletteSearch.scope === 'content'}
								onPressedChange={(v) => { signedIn.state.paletteSearch.scope = v ? 'content': 'both'; }}
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
