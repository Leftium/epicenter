<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import * as Resizable from '@epicenter/ui/resizable';
	import * as Sheet from '@epicenter/ui/sheet';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import { onDestroy, tick } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { beforeNavigate } from '$app/navigation';
	import { basename } from '$lib/files.js';
	import { createLeaveGuard } from '$lib/leave.svelte.js';
	import type { Library } from '$lib/library.svelte.js';
	import AppHeader from './AppHeader.svelte';
	import FileBrowser from './FileBrowser.svelte';
	import FileView from './FileView.svelte';
	import FolderTerminal from './FolderTerminal.svelte';
	import RecordingDetail from './RecordingDetail.svelte';
	import LeavePrompt from './LeavePrompt.svelte';
	import RecordingList from './RecordingList.svelte';

	let { library }: { library: Library } = $props();

	// Typing and captured audio that have not reached the folder live only in
	// this window. In a browser tab, leaving while either exists is cancelled,
	// which the browser turns into its own leave warning. The desktop shell
	// does not raise that warning, so it asks before closing or quitting and
	// the leave guard answers, showing a confirmation when something is held.
	beforeNavigate(({ cancel }) => {
		if (library.holdsUnsavedWork) cancel();
	});
	// One library per mounted view: the page opens it once and never swaps it.
	// svelte-ignore state_referenced_locally
	const leave = createLeaveGuard(library, library.workspace.closing);
	onDestroy(() => leave.dispose());

	/** Below this width, the list, details, and terminal take turns. */
	const wide = new MediaQuery('(min-width: 768px)');
	let filesPane = $state(false);
	let filesSheet = $state(false);
	let terminalOpen = $state(false);
	/** On narrow windows, whether the details show in place of the list. */
	let showingDetail = $state(false);

	function toggleFiles() {
		if (wide.current) filesPane = !filesPane;
		else filesSheet = !filesSheet;
	}

	async function toggleTerminal() {
		terminalOpen = !terminalOpen;
		if (terminalOpen) return;
		// The command field left with the terminal; give focus back to its toggle.
		await tick();
		if (document.activeElement === null || document.activeElement === document.body)
			document.querySelector<HTMLElement>('[data-terminal-toggle]')?.focus();
	}

	function showDetail() {
		if (wide.current) return;
		showingDetail = true;
		filesSheet = false;
		terminalOpen = false;
	}

	async function back() {
		const path = library.selectedPath;
		showingDetail = false;
		await tick();
		if (path !== undefined)
			document.querySelector<HTMLElement>(`[data-recording="${CSS.escape(path)}"]`)?.focus();
	}
</script>

<!-- Returning to the app is a refresh boundary for files and Git status. -->
<svelte:window
	onfocus={() => void library.refreshAll()}
	onkeydown={(event) => {
		if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'b') {
			event.preventDefault();
			toggleFiles();
		} else if (event.ctrlKey && event.key === '`') {
			event.preventDefault();
			void toggleTerminal();
		}
	}}
/>

{#snippet detail(onBack: (() => void) | undefined)}
	{@const selection = library.selection}
	{#if selection?.kind === 'recording'}
		{#key selection.editor}
			<RecordingDetail {library} editor={selection.editor} entry={selection.entry} {onBack} />
		{/key}
	{:else if selection?.kind === 'file'}
		<FileView {library} path={selection.path} file={selection.file} {onBack} />
	{:else}
		<Empty.Root class="h-full">
			{#if library.selectedPath !== undefined}
				<Empty.Title>{basename(library.selectedPath)} is no longer in the folder</Empty.Title>
				<Empty.Description>It was renamed or deleted outside this window.</Empty.Description>
			{:else}
				<Empty.Title>Select a recording</Empty.Title>
				<Empty.Description>Its audio, transcription, notes, and source open here. Any other file opens from Files.</Empty.Description>
			{/if}
			{#if onBack}
				<Button variant="outline" size="sm" onclick={onBack}><ArrowLeftIcon /> Back to recordings</Button>
			{/if}
		</Empty.Root>
	{/if}
{/snippet}

{#snippet terminalPane()}
	<FolderTerminal session={library.terminal} note={library.workspace.terminalNote} onClose={() => void toggleTerminal()} />
{/snippet}

<LeavePrompt guard={leave} />

<div class="flex h-dvh flex-col overflow-hidden">
	<AppHeader
		{library}
		filesOpen={wide.current ? filesPane : filesSheet}
		{terminalOpen}
		onToggleFiles={toggleFiles}
		onToggleTerminal={() => void toggleTerminal()}
	/>

	{#if wide.current}
		<Resizable.PaneGroup direction="vertical" class="min-h-0 flex-1">
			<Resizable.Pane id="workspace" order={1} minSize={30}>
				<Resizable.PaneGroup direction="horizontal">
					{#if filesPane}
						<Resizable.Pane id="files" order={1} defaultSize={22} minSize={14} maxSize={40}>
							<FileBrowser {library} />
						</Resizable.Pane>
						<Resizable.Handle />
					{/if}
					<Resizable.Pane id="list" order={2} defaultSize={filesPane ? 30 : 38} minSize={20}>
						<RecordingList {library} />
					</Resizable.Pane>
					<Resizable.Handle />
					<Resizable.Pane id="detail" order={3} defaultSize={filesPane ? 48 : 62} minSize={30}>
						{@render detail(undefined)}
					</Resizable.Pane>
				</Resizable.PaneGroup>
			</Resizable.Pane>
			{#if terminalOpen}
				<Resizable.Handle />
				<Resizable.Pane id="terminal" order={2} defaultSize={32} minSize={15} maxSize={70}>
					{@render terminalPane()}
				</Resizable.Pane>
			{/if}
		</Resizable.PaneGroup>
	{:else}
		<main class="min-h-0 flex-1">
			{#if terminalOpen}
				{@render terminalPane()}
			{:else if showingDetail}
				{@render detail(back)}
			{:else}
				<RecordingList {library} onOpen={showDetail} />
			{/if}
		</main>
		<Sheet.Root bind:open={filesSheet}>
			<!-- Named directly: the browser's own visible heading is the only "Files" heading. -->
			<Sheet.Content side="left" class="gap-0 p-0" aria-label="Files">
				<FileBrowser {library} onOpen={showDetail} />
			</Sheet.Content>
		</Sheet.Root>
	{/if}
</div>
