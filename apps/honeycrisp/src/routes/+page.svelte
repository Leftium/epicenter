<script lang="ts">
	import * as Resizable from '@epicenter/ui/resizable';
	import { SidebarProvider } from '@epicenter/ui/sidebar';
	import type { DocumentHandle } from '@epicenter/workspace';
	import type * as Y from 'yjs';
	import CommandPalette from '$lib/components/CommandPalette.svelte';
	import HoneycripEditor from '$lib/components/Editor.svelte';
	import NoteList from '$lib/components/NoteList.svelte';
	import HoneycripSidebar from '$lib/components/Sidebar.svelte';
	import { notesState } from '$lib/state/notes.svelte';
	import workspaceClient from '$lib/workspace';

	// ─── Recently Deleted View ──────────────────────────────────────────────

	let isRecentlyDeletedView = $state(false);
	let commandPaletteOpen = $state(false);

	const folderName = $derived(
		isRecentlyDeletedView
			? 'Recently Deleted'
			: notesState.selectedFolderId
				? (notesState.folders.find((f) => f.id === notesState.selectedFolderId)
						?.name ?? 'Notes')
				: 'All Notes',
	);

	// ─── Document Handle ────────────────────────────────────────────────────

	let currentYXmlFragment = $state<Y.XmlFragment | null>(null);
	let currentDocHandle = $state<DocumentHandle | null>(null);

	$effect(() => {
		const noteId = notesState.selectedNoteId;
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
			notesState.createFolder();
		} else if (e.key === 'n') {
			e.preventDefault();
			notesState.createNote();
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<SidebarProvider>
	<HoneycripSidebar
		folders={notesState.folders}
		selectedFolderId={notesState.selectedFolderId}
		noteCounts={notesState.noteCounts}
		totalNoteCount={notesState.notes.length}
		searchQuery={notesState.searchQuery}
		deletedNoteCount={notesState.deletedNotes.length}
		isRecentlyDeletedSelected={isRecentlyDeletedView}
		onSelectFolder={(folderId) => {
			isRecentlyDeletedView = false;
			notesState.selectFolder(folderId);
		}}
		onCreateFolder={() => notesState.createFolder()}
		onRenameFolder={(id, name) => notesState.renameFolder(id, name)}
		onDeleteFolder={(id) => notesState.deleteFolder(id)}
		onSearchChange={(q) => notesState.setSearchQuery(q)}
		onSelectRecentlyDeleted={() => {
			isRecentlyDeletedView = true;
			notesState.selectFolder(null);
		}}
	/>

	<main class="flex h-screen flex-1 overflow-hidden">
		<Resizable.PaneGroup direction="horizontal">
			<Resizable.Pane defaultSize={35} minSize={20} class="border-r">
				<NoteList
					notes={isRecentlyDeletedView ? notesState.deletedNotes : notesState.filteredNotes}
					selectedNoteId={notesState.selectedNoteId}
					sortBy={notesState.sortBy}
					viewMode={isRecentlyDeletedView ? 'recentlyDeleted' : 'normal'}
					{folderName}
					folders={notesState.folders}
					onSelectNote={(id) => notesState.selectNote(id)}
					onCreateNote={() => notesState.createNote()}
					onDeleteNote={(id) => notesState.softDeleteNote(id)}
					onPinNote={(id) => notesState.pinNote(id)}
					onSortChange={(v) => notesState.setSortBy(v)}
					onRestoreNote={(id) => notesState.restoreNote(id)}
					onPermanentlyDeleteNote={(id) => notesState.permanentlyDeleteNote(id)}
					onMoveToFolder={(noteId, folderId) => notesState.moveNoteToFolder(noteId, folderId)}
				/>
			</Resizable.Pane>
			<Resizable.Handle />
			<Resizable.Pane defaultSize={65} minSize={30} class="flex flex-col">
				{#if notesState.selectedNote && currentYXmlFragment}
					{#key notesState.selectedNoteId}
						<HoneycripEditor
							yxmlfragment={currentYXmlFragment}
							onContentChange={(change) => notesState.updateNoteContent(change)}
						/>
					{/key}
				{:else if notesState.selectedNote}
					<div class="flex h-full items-center justify-center">
						<p class="text-muted-foreground">Loading editor…</p>
					</div>
				{:else}
					<div class="flex h-full flex-col items-center justify-center gap-2">
						<p class="text-muted-foreground">No note selected</p>
						<p class="text-sm text-muted-foreground/60">
							Choose a note from the list or press ⌘N to create one
						</p>
					</div>
				{/if}
			</Resizable.Pane>
		</Resizable.PaneGroup>
	</main>
</SidebarProvider>

<CommandPalette
	bind:open={commandPaletteOpen}
	notes={notesState.notes}
	folders={notesState.folders}
	onSelectNote={(noteId) => {
		isRecentlyDeletedView = false;
		notesState.selectNote(noteId);
	}}
	onSelectFolder={(folderId) => {
		isRecentlyDeletedView = false;
		notesState.selectFolder(folderId);
	}}
	onCreateNote={() => notesState.createNote()}
	onCreateFolder={() => notesState.createFolder()}
/>
