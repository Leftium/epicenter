<script lang="ts">
	import * as Resizable from '@epicenter/ui/resizable';
	import { SidebarProvider } from '@epicenter/ui/sidebar';
	import type { DocumentHandle } from '@epicenter/workspace';
	import type * as Y from 'yjs';
	import HoneycripEditor from '$lib/components/Editor.svelte';
	import NoteList from '$lib/components/NoteList.svelte';
	import HoneycripSidebar from '$lib/components/Sidebar.svelte';
	import CommandPalette from '$lib/components/CommandPalette.svelte';
	import {
		createFolder,
		createNote,
		deletedNotes,
		deleteFolder,
		filteredNotes,
		folders,
		handleContentChange,
		noteCounts,
		notes,
		permanentlyDeleteNote,
		pinNote,
		renameFolder,
		restoreNote,
		searchQuery,
		selectedFolderId,
		selectedNote,
		selectedNoteId,
		selectFolder,
		selectNote,
		setSearchQuery,
		setSortBy,
		softDeleteNote,
		sortBy,
	} from '$lib/state/notes.svelte';
	import workspaceClient, { type FolderId, type NoteId } from '$lib/workspace';

	// ─── Move to Folder ────────────────────────────────────────────────────

	function moveNoteToFolder(noteId: NoteId, folderId: FolderId | undefined) {
		workspaceClient.tables.notes.update(noteId, { folderId });
	}

	// ─── Recently Deleted View ──────────────────────────────────────────────

	let isRecentlyDeletedView = $state(false);
	let commandPaletteOpen = $state(false);

	const folderName = $derived(
		isRecentlyDeletedView
			? 'Recently Deleted'
			: selectedFolderId
				? (folders.find((f) => f.id === selectedFolderId)?.name ?? 'Notes')
				: 'All Notes',
	);

	// ─── Document Handle ────────────────────────────────────────────────────

	let currentYXmlFragment = $state<Y.XmlFragment | null>(null);
	let currentDocHandle = $state<DocumentHandle | null>(null);

	$effect(() => {
		const noteId = selectedNoteId;
		if (!noteId) {
			currentYXmlFragment = null;
			currentDocHandle = null;
			return;
		}

		let cancelled = false;
		workspaceClient.documents.notes.body.open(noteId).then((handle) => {
			if (cancelled) return;
			currentDocHandle = handle;
			currentYXmlFragment = handle.ydoc.getXmlFragment('content');
		});

		return () => {
			cancelled = true;
			if (currentDocHandle) {
				workspaceClient.documents.notes.body.close(noteId);
			}
			currentYXmlFragment = null;
			currentDocHandle = null;
		};
	});

	// ─── Keyboard Shortcuts ──────────────────────────────────────────────────

	function handleKeydown(e: KeyboardEvent) {
		const meta = e.metaKey || e.ctrlKey;
		if (!meta) return;

		if (e.key === 'k') {
			e.preventDefault();
			commandPaletteOpen = !commandPaletteOpen;
			return;
		}

		if (e.key === 'n' && e.shiftKey) {
			e.preventDefault();
			createFolder();
		} else if (e.key === 'n') {
			e.preventDefault();
			createNote();
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<SidebarProvider>
	<HoneycripSidebar
		{folders}
		{selectedFolderId}
		{noteCounts}
		totalNoteCount={notes.length}
		{searchQuery}
		deletedNoteCount={deletedNotes.length}
		isRecentlyDeletedSelected={isRecentlyDeletedView}
		onSelectFolder={(folderId) => {
			isRecentlyDeletedView = false;
			selectFolder(folderId);
		}}
		onCreateFolder={createFolder}
		onRenameFolder={renameFolder}
		onDeleteFolder={deleteFolder}
		onSearchChange={setSearchQuery}
		onSelectRecentlyDeleted={() => {
			isRecentlyDeletedView = true;
			selectFolder(null);
		}}
	/>

	<main class="flex h-screen flex-1 overflow-hidden">
		<Resizable.PaneGroup direction="horizontal">
			<Resizable.Pane defaultSize={35} minSize={20} class="border-r">
				<NoteList
					notes={isRecentlyDeletedView ? deletedNotes : filteredNotes}
					{selectedNoteId}
					{sortBy}
					viewMode={isRecentlyDeletedView ? 'recentlyDeleted' : 'normal'}
					{folderName}
					onSelectNote={selectNote}
					onCreateNote={createNote}
					onDeleteNote={softDeleteNote}
					onPinNote={pinNote}
					onSortChange={setSortBy}
					onRestoreNote={restoreNote}
					onPermanentlyDeleteNote={permanentlyDeleteNote}
					onMoveToFolder={moveNoteToFolder}
					{folders}
				/>
			</Resizable.Pane>
			<Resizable.Handle />
			<Resizable.Pane defaultSize={65} minSize={30} class="flex flex-col">
				{#if selectedNote && currentYXmlFragment}
					{#key selectedNoteId}
						<HoneycripEditor
							yxmlfragment={currentYXmlFragment}
							onContentChange={handleContentChange}
						/>
					{/key}
				{:else if selectedNote}
					<div class="flex h-full items-center justify-center">
						<p class="text-muted-foreground">Loading editor…</p>
					</div>
				{:else}
					<div class="flex h-full items-center justify-center">
						<p class="text-muted-foreground">Select or create a note</p>
					</div>
				{/if}
			</Resizable.Pane>
		</Resizable.PaneGroup>
	</main>
</SidebarProvider>

<CommandPalette
	bind:open={commandPaletteOpen}
	{notes}
	{folders}
	onSelectNote={(noteId) => {
		isRecentlyDeletedView = false;
		selectNote(noteId);
	}}
	onSelectFolder={(folderId) => {
		isRecentlyDeletedView = false;
		selectFolder(folderId);
	}}
	onCreateNote={createNote}
	onCreateFolder={createFolder}
/>
