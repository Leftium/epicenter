/**
 * Reactive notes state for Honeycrisp.
 *
 * Module-level `$state` and `$derived` provide reactive state that persists
 * for the application's lifetime. Workspace observers keep state in sync
 * with the Y.Doc CRDT. Actions mutate state through the workspace client.
 *
 * This is a single-page SPA — observers are registered once at module
 * initialization and never cleaned up (they live for the app's lifetime).
 * Same pattern as tab-manager's `saved-tab-state.svelte.ts`.
 *
 * @example
 * ```svelte
 * <script>
 *   import { folders, notes, createNote } from '$lib/state/notes.svelte';
 * </script>
 *
 * {#each notes as note (note.id)}
 *   <p>{note.title}</p>
 * {/each}
 * <button onclick={createNote}>New Note</button>
 * ```
 */

import { dateTimeStringNow, generateId } from '@epicenter/workspace';
import workspaceClient, {
	type Folder,
	type FolderId,
	type Note,
	type NoteId,
} from '$lib/workspace';

// ─── Reactive State ──────────────────────────────────────────────────────

let folders = $state<Folder[]>(workspaceClient.tables.folders.getAllValid());
let allNotes = $state<Note[]>(workspaceClient.tables.notes.getAllValid());

let selectedFolderId = $state<FolderId | null>(
	workspaceClient.kv.get('selectedFolderId'),
);

let selectedNoteId = $state<NoteId | null>(
	workspaceClient.kv.get('selectedNoteId'),
);

let sortBy = $state<'dateEdited' | 'dateCreated' | 'title'>(
	workspaceClient.kv.get('sortBy'),
);

let searchQuery = $state('');

// ─── Workspace Observers ─────────────────────────────────────────────────

// Observers fire on Y.Doc changes (local + remote). They wholesale-replace
// the $state arrays — same pattern as tab-manager's saved-tab-state.

workspaceClient.tables.folders.observe(() => {
	folders = workspaceClient.tables.folders.getAllValid();
});

workspaceClient.tables.notes.observe(() => {
	allNotes = workspaceClient.tables.notes.getAllValid();
});

workspaceClient.kv.observe('selectedFolderId', (change) => {
	selectedFolderId = change.type === 'set' ? change.value : null;
});

workspaceClient.kv.observe('selectedNoteId', (change) => {
	selectedNoteId = change.type === 'set' ? change.value : null;
});

workspaceClient.kv.observe('sortBy', (change) => {
	sortBy = change.type === 'set' ? change.value : 'dateEdited';
});

// ─── Derived State ───────────────────────────────────────────────────────

/** Active notes — not soft-deleted. */
const notes = $derived(allNotes.filter((n) => n.deletedAt === undefined));

/** Soft-deleted notes for the Recently Deleted view. */
const deletedNotes = $derived(
	allNotes.filter((n) => n.deletedAt !== undefined),
);

/** Notes filtered by selected folder and search query. */
const filteredNotes = $derived.by(() => {
	let result =
		selectedFolderId === null
			? notes
			: notes.filter((n) => n.folderId === selectedFolderId);
	if (searchQuery.trim()) {
		const q = searchQuery.trim().toLowerCase();
		result = result.filter(
			(n) =>
				n.title.toLowerCase().includes(q) ||
				n.preview.toLowerCase().includes(q),
		);
	}
	result = [...result].sort((a, b) => {
		if (sortBy === 'title') return a.title.localeCompare(b.title);
		if (sortBy === 'dateCreated') return b.createdAt.localeCompare(a.createdAt);
		return b.updatedAt.localeCompare(a.updatedAt);
	});
	return result;
});

/** Per-folder note counts for the sidebar (active notes only). */
const noteCounts = $derived.by(() => {
	const counts: Record<string, number> = {};
	for (const note of notes) {
		if (note.folderId) {
			counts[note.folderId] = (counts[note.folderId] ?? 0) + 1;
		}
	}
	return counts;
});

/** The currently selected note (can be active or deleted). */
const selectedNote = $derived(
	allNotes.find((n) => n.id === selectedNoteId) ?? null,
);

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

function renameFolder(folderId: FolderId, name: string) {
	workspaceClient.tables.folders.update(folderId, { name });
}

function deleteFolder(folderId: FolderId) {
	const folderNotes = allNotes.filter((n) => n.folderId === folderId);
	for (const note of folderNotes) {
		workspaceClient.tables.notes.update(note.id, { folderId: undefined });
	}
	workspaceClient.tables.folders.delete(folderId);
	if (selectedFolderId === folderId) {
		workspaceClient.kv.set('selectedFolderId', null);
	}
}

function createNote() {
	const id = generateId() as unknown as NoteId;
	workspaceClient.tables.notes.set({
		id,
		folderId: selectedFolderId ?? undefined,
		title: '',
		preview: '',
		pinned: false,
		deletedAt: undefined,
		createdAt: dateTimeStringNow(),
		updatedAt: dateTimeStringNow(),
		_v: 2,
	});
	workspaceClient.kv.set('selectedNoteId', id);
}

/** Soft-delete a note — moves it to Recently Deleted. */
function softDeleteNote(noteId: NoteId) {
	workspaceClient.tables.notes.update(noteId, {
		deletedAt: dateTimeStringNow(),
	});
	if (selectedNoteId === noteId) {
		workspaceClient.kv.set('selectedNoteId', null);
	}
}

/** Restore a soft-deleted note from Recently Deleted. */
function restoreNote(noteId: NoteId) {
	const note = allNotes.find((n) => n.id === noteId);
	if (!note) return;
	// If the note's folder no longer exists, restore to unfiled
	const folderExists = note.folderId
		? folders.some((f) => f.id === note.folderId)
		: true;
	workspaceClient.tables.notes.update(noteId, {
		deletedAt: undefined,
		...(folderExists ? {} : { folderId: undefined }),
	});
}

/** Permanently delete a note — no recovery. */
function permanentlyDeleteNote(noteId: NoteId) {
	workspaceClient.tables.notes.delete(noteId);
	if (selectedNoteId === noteId) {
		workspaceClient.kv.set('selectedNoteId', null);
	}
}

function pinNote(noteId: NoteId) {
	const note = allNotes.find((n) => n.id === noteId);
	if (!note) return;
	workspaceClient.tables.notes.update(noteId, { pinned: !note.pinned });
}

function selectFolder(folderId: FolderId | null) {
	workspaceClient.kv.set('selectedFolderId', folderId);
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

function setSortBy(value: 'dateEdited' | 'dateCreated' | 'title') {
	workspaceClient.kv.set('sortBy', value);
}

function setSearchQuery(query: string) {
	searchQuery = query;
}

// ─── Exports ─────────────────────────────────────────────────────────────

export {
	allNotes,
	// Actions
	createFolder,
	createNote,
	deletedNotes,
	deleteFolder,
	filteredNotes,
	// State
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
};
