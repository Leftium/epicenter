<script lang="ts">
	import * as Resizable from '@epicenter/ui/resizable';
	import { SidebarProvider } from '@epicenter/ui/sidebar';
	import type { DocumentHandle } from '@epicenter/workspace';
	import type * as Y from 'yjs';
	import HoneycripEditor from '$lib/components/Editor.svelte';
	import NoteList from '$lib/components/NoteList.svelte';
	import HoneycripSidebar from '$lib/components/Sidebar.svelte';
	import {
		createFolder,
		createNote,
		deleteFolder,
		filteredNotes,
		folders,
		handleContentChange,
		noteCounts,
		notes,
		pinNote,
		renameFolder,
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
	import workspaceClient from '$lib/workspace';

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
		onSelectFolder={selectFolder}
		onCreateFolder={createFolder}
		onRenameFolder={renameFolder}
		onDeleteFolder={deleteFolder}
		onSearchChange={setSearchQuery}
	/>

	<main class="flex h-screen flex-1 overflow-hidden">
		<Resizable.PaneGroup direction="horizontal">
			<Resizable.Pane defaultSize={35} minSize={20} class="border-r">
				<NoteList
					notes={filteredNotes}
					{selectedNoteId}
					{sortBy}
					onSelectNote={selectNote}
					onCreateNote={createNote}
					onDeleteNote={softDeleteNote}
					onPinNote={pinNote}
					onSortChange={setSortBy}
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
