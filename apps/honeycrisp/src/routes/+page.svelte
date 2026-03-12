<script lang="ts">
	import * as Resizable from '@epicenter/ui/resizable';
	import { SidebarProvider } from '@epicenter/ui/sidebar';
	import type { DocumentHandle } from '@epicenter/workspace';
	import { dateTimeStringNow, generateId } from '@epicenter/workspace';
	import type * as Y from 'yjs';
	import HoneycripEditor from '$lib/components/Editor.svelte';
	import NoteList from '$lib/components/NoteList.svelte';
	import HoneycripSidebar from '$lib/components/Sidebar.svelte';
	import workspaceClient, {
		type Folder,
		type FolderId,
		type Note,
		type NoteId,
	} from '$lib/workspace';

	// ─── Reactive State ──────────────────────────────────────────────────────

	let folders = $state<Folder[]>([]);
	let notes = $state<Note[]>([]);
	let selectedFolderId = $state<FolderId | null>(null);
	let selectedNoteId = $state<NoteId | null>(null);
	let currentYText = $state<Y.Text | null>(null);
	let currentDocHandle = $state<DocumentHandle | null>(null);

	// ─── Workspace Observation ───────────────────────────────────────────────

	$effect(() => {
		folders = workspaceClient.tables.folders.getAllValid();
		notes = workspaceClient.tables.notes.getAllValid();

		const kvFolderId = workspaceClient.kv.get('selectedFolderId');
		selectedFolderId = kvFolderId.status === 'valid' ? kvFolderId.value : null;

		const kvNoteId = workspaceClient.kv.get('selectedNoteId');
		selectedNoteId = kvNoteId.status === 'valid' ? kvNoteId.value : null;

		const unsubFolders = workspaceClient.tables.folders.observe(() => {
			folders = workspaceClient.tables.folders.getAllValid();
		});
		const unsubNotes = workspaceClient.tables.notes.observe(() => {
			notes = workspaceClient.tables.notes.getAllValid();
		});
		const unsubFolderKv = workspaceClient.kv.observe(
			'selectedFolderId',
			(change) => {
				selectedFolderId = change.type === 'set' ? change.value : null;
			},
		);
		const unsubNoteKv = workspaceClient.kv.observe(
			'selectedNoteId',
			(change) => {
				selectedNoteId = change.type === 'set' ? change.value : null;
			},
		);

		return () => {
			unsubFolders();
			unsubNotes();
			unsubFolderKv();
			unsubNoteKv();
		};
	});

	// ─── Derived State ───────────────────────────────────────────────────────

	/** Notes filtered by selected folder (or all notes if no folder selected). */
	const filteredNotes = $derived(
		selectedFolderId === null
			? notes
			: notes.filter((n) => n.folderId === selectedFolderId),
	);

	/** Per-folder note counts for the sidebar. */
	const noteCounts = $derived.by(() => {
		const counts: Record<string, number> = {};
		for (const note of notes) {
			if (note.folderId) {
				counts[note.folderId] = (counts[note.folderId] ?? 0) + 1;
			}
		}
		return counts;
	});

	const selectedNote = $derived(
		notes.find((n) => n.id === selectedNoteId) ?? null,
	);

	// ─── Document Handle (Y.Text) ────────────────────────────────────────────

	$effect(() => {
		const noteId = selectedNoteId;
		if (!noteId) {
			currentYText = null;
			currentDocHandle = null;
			return;
		}

		let cancelled = false;
		workspaceClient.documents.notes.body.open(noteId).then((handle) => {
			if (cancelled) return;
			currentDocHandle = handle;
			currentYText = handle.ydoc.getText('content');
		});

		return () => {
			cancelled = true;
			if (currentDocHandle) {
				workspaceClient.documents.notes.body.close(noteId);
			}
			currentYText = null;
			currentDocHandle = null;
		};
	});

	// ─── Actions ─────────────────────────────────────────────────────────────

	function createFolder() {
		const id = generateId() as unknown as FolderId;
		const sortOrder = folders.length;
		workspaceClient.tables.folders.set({
			id,
			name: 'New Folder',
			sortOrder,
			_v: 1,
		});
	}

	function createNote() {
		const id = generateId() as unknown as NoteId;
		workspaceClient.tables.notes.set({
			id,
			folderId: selectedFolderId ?? undefined,
			title: '',
			preview: '',
			pinned: false,
			createdAt: dateTimeStringNow(),
			updatedAt: dateTimeStringNow(),
			_v: 1,
		});
		workspaceClient.kv.set('selectedNoteId', id);
	}

	function selectFolder(folderId: FolderId | null) {
		workspaceClient.kv.set('selectedFolderId', folderId);
		// Clear note selection when switching folders
		workspaceClient.kv.set('selectedNoteId', null);
	}

	function selectNote(noteId: NoteId) {
		workspaceClient.kv.set('selectedNoteId', noteId);
	}

	function handleContentChange({
		title,
		preview,
	}: {
		title: string;
		preview: string;
	}) {
		if (!selectedNoteId) return;
		workspaceClient.tables.notes.update(selectedNoteId, { title, preview });
	}
</script>

<SidebarProvider>
	<HoneycripSidebar
		{folders}
		{selectedFolderId}
		{noteCounts}
		totalNoteCount={notes.length}
		onSelectFolder={selectFolder}
		onCreateFolder={createFolder}
	/>

	<main class="flex h-screen flex-1 overflow-hidden">
		<Resizable.PaneGroup direction="horizontal">
			<Resizable.Pane defaultSize={35} minSize={20} class="border-r">
				<NoteList
					notes={filteredNotes}
					{selectedNoteId}
					onSelectNote={selectNote}
					onCreateNote={createNote}
				/>
			</Resizable.Pane>
			<Resizable.Handle withHandle />
			<Resizable.Pane defaultSize={65} minSize={30} class="flex flex-col">
				{#if selectedNote && currentYText}
					{#key selectedNoteId}
						<HoneycripEditor
							ytext={currentYText}
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
