<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import * as Resizable from '@epicenter/ui/resizable';
	import { toast } from '@epicenter/ui/sonner';
	import { tick } from 'svelte';
	import { beforeNavigate } from '$app/navigation';
	import { basename } from '@epicenter/folder/file-browser';
	import type { Notes } from '$lib/notes.svelte.js';
	import AppHeader from './AppHeader.svelte';
	import FileBrowser from './FileBrowser.svelte';
	import FileView from './FileView.svelte';
	import FolderNav from './FolderNav.svelte';
	import FolderTerminal from './FolderTerminal.svelte';
	import NoteDetail from './NoteDetail.svelte';
	import NoteList from './NoteList.svelte';

	let { notes }: { notes: Notes } = $props();

	let filesOpen = $state(false);
	let terminalOpen = $state(false);

	// Drafts live only in this window. Three things can end it, and each is held
	// back while a draft is unsettled:
	// - a reload or in-page navigation: cancelled here, and the webview asks first;
	// - closing the window or quitting the app: the shell asks the page, which
	//   answers from `+page.svelte` before these notes exist. While it answers,
	//   `notes.fenced` holds back every input and action here.
	beforeNavigate(({ cancel }) => {
		if (notes.unsettled > 0) cancel();
	});

	async function toggleTerminal() {
		terminalOpen = !terminalOpen;
		if (terminalOpen) return;
		await tick();
		if (document.activeElement === null || document.activeElement === document.body)
			document.querySelector<HTMLElement>('[data-terminal-toggle]')?.focus();
	}
</script>

<!-- Returning to the app is a refresh boundary for files and Git status. -->
<svelte:window
	onfocus={() => void notes.refreshAll()}
	onbeforeunload={(event) => {
		if (notes.unsettled > 0) event.preventDefault();
	}}
	onkeydown={async (event) => {
		const mod = event.metaKey || event.ctrlKey;
		if ((event.key === 'F5' || (mod && event.key.toLowerCase() === 'r')) && notes.unsettled > 0) {
			// A reload would end this window's drafts. The leave prompt below is
			// the webview's to show or not; refusing the shortcut does not depend on it.
			event.preventDefault();
			toast.warning('Reload stopped: some changes are not saved or not confirmed', {
				description: 'Wait for them to save, or resolve them in the note or the status menu, then reload.',
			});
		} else if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'b') {
			event.preventDefault();
			filesOpen = !filesOpen;
		} else if (event.ctrlKey && event.key === '`') {
			event.preventDefault();
			void toggleTerminal();
		} else if (mod && !event.shiftKey && event.key.toLowerCase() === 'n') {
			event.preventDefault();
			const problem = await notes.createNote();
			if (problem) toast.error('Could not create the note', { description: problem });
		}
	}}
/>

<!-- While a close is being answered nothing here takes input. The editors stay
     mounted, so Keep editing returns to the same text and undo history. -->
<div class="flex h-dvh flex-col overflow-hidden" inert={notes.fenced}>
	<AppHeader
		{notes}
		{filesOpen}
		{terminalOpen}
		onToggleFiles={() => (filesOpen = !filesOpen)}
		onToggleTerminal={() => void toggleTerminal()}
	/>

	<Resizable.PaneGroup direction="vertical" class="min-h-0 flex-1">
		<Resizable.Pane id="main" order={1} minSize={30}>
			<Resizable.PaneGroup direction="horizontal">
				<Resizable.Pane id="folders" order={1} defaultSize={16} minSize={10} maxSize={30}>
					<FolderNav {notes} />
				</Resizable.Pane>
				<Resizable.Handle />
				<Resizable.Pane id="list" order={2} defaultSize={24} minSize={15}>
					<NoteList {notes} />
				</Resizable.Pane>
				<Resizable.Handle />
				<Resizable.Pane id="detail" order={3} defaultSize={filesOpen ? 40 : 60} minSize={30}>
					{@const selection = notes.selection}
					{#if selection?.kind === 'note'}
						<!-- One mount per note; a rename hands it a new editor without remounting. -->
						{#key selection.key}
							<NoteDetail {notes} editor={selection.session} />
						{/key}
					{:else if selection?.kind === 'file'}
						<FileView {notes} path={selection.path} file={selection.file} />
					{:else}
						<Empty.Root class="h-full">
							{#if notes.selectedPath !== undefined}
								<Empty.Title>{basename(notes.selectedPath)} is no longer in the folder</Empty.Title>
								<Empty.Description>It was renamed or deleted outside this editor.</Empty.Description>
							{:else}
								<Empty.Title>No note selected</Empty.Title>
								<Empty.Description>Choose a note from the list, or press ⌘N to create one.</Empty.Description>
							{/if}
						</Empty.Root>
					{/if}
				</Resizable.Pane>
				{#if filesOpen}
					<Resizable.Handle />
					<Resizable.Pane id="files" order={4} defaultSize={20} minSize={14} maxSize={40}>
						<FileBrowser {notes} />
					</Resizable.Pane>
				{/if}
			</Resizable.PaneGroup>
		</Resizable.Pane>
		{#if terminalOpen}
			<Resizable.Handle />
			<Resizable.Pane id="terminal" order={2} defaultSize={32} minSize={15} maxSize={70}>
				<FolderTerminal session={notes.terminal} onClose={() => void toggleTerminal()} />
			</Resizable.Pane>
		{/if}
	</Resizable.PaneGroup>
</div>
