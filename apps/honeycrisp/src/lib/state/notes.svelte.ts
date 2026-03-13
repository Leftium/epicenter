/**
 * Reactive notes state for Honeycrisp.
 *
 * Backed by a Y.Doc CRDT table, so notes sync across devices. Uses a
 * factory function pattern to encapsulate `$state` — Svelte 5 doesn't
 * allow exporting reassigned `$state` from modules.
 *
 * Uses a plain `$state` array (not `SvelteMap`) because the access pattern
 * is always "render the full sorted list." There's no keyed lookup, no
 * partial mutation — the Y.Doc observer wholesale-replaces the array on
 * every change, which is the simplest reactive model for a list that's
 * always read in full.
 *
 * Observers are registered once during factory construction and never
 * cleaned up (SPA lifetime). Same pattern as tab-manager's
 * `saved-tab-state.svelte.ts`.
 *
 * @example
 * ```svelte
 * <script>
 *   import { notesState } from '$lib/state/notes.svelte';
 * </script>
 *
 * {#each notesState.notes as note (note.id)}
 *   <p>{note.title}</p>
 * {/each}
 * <button onclick={() => notesState.createNote()}>New Note</button>
 * ```
 */

import { dateTimeStringNow, generateId } from '@epicenter/workspace';
import workspaceClient, {
	type Folder,
	type FolderId,
	type Note,
	type NoteId,
} from '$lib/workspace';

function createNotesState() {
	// ─── Reactive State ──────────────────────────────────────────────────

	/** Read all valid folders, used as initial seed + observer refresh. */
	const readFolders = () => workspaceClient.tables.folders.getAllValid();

	/** Read all valid notes (including deleted), used as initial seed + observer refresh. */
	const readNotes = () => workspaceClient.tables.notes.getAllValid();

	let folders = $state<Folder[]>(readFolders());
	let allNotes = $state<Note[]>(readNotes());

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
	let isRecentlyDeletedView = $state(false);

	// ─── Workspace Observers ─────────────────────────────────────────────

	// Observers fire on Y.Doc changes (local + remote). They wholesale-replace
	// the $state arrays — same pattern as tab-manager's saved-tab-state.

	workspaceClient.tables.folders.observe(() => {
		folders = readFolders();
	});

	workspaceClient.tables.notes.observe(() => {
		allNotes = readNotes();
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

	// ─── Derived State ───────────────────────────────────────────────────

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
		return [...result].sort((a, b) => {
			if (sortBy === 'title') return a.title.localeCompare(b.title);
			if (sortBy === 'dateCreated')
				return b.createdAt.localeCompare(a.createdAt);
			return b.updatedAt.localeCompare(a.updatedAt);
		});
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

	/** Human-readable name for the current view (sidebar + NoteList header). */
	const folderName = $derived(
		isRecentlyDeletedView
			? 'Recently Deleted'
			: selectedFolderId
				? (folders.find((f) => f.id === selectedFolderId)?.name ?? 'Notes')
				: 'All Notes',
	);

	/** The currently selected note (can be active or deleted). */
	const selectedNote = $derived(
		allNotes.find((n) => n.id === selectedNoteId) ?? null,
	);

	// ─── Public API ──────────────────────────────────────────────────────

	return {
		// State (read-only via getters)
		get folders() {
			return folders;
		},
		get allNotes() {
			return allNotes;
		},
		get notes() {
			return notes;
		},
		get deletedNotes() {
			return deletedNotes;
		},
		get filteredNotes() {
			return filteredNotes;
		},
		get noteCounts() {
			return noteCounts;
		},
		get selectedFolderId() {
			return selectedFolderId;
		},
		get selectedNoteId() {
			return selectedNoteId;
		},
		get selectedNote() {
			return selectedNote;
		},
		get searchQuery() {
			return searchQuery;
		},
		get sortBy() {
			return sortBy;
		},
		get isRecentlyDeletedView() {
			return isRecentlyDeletedView;
		},
		get folderName() {
			return folderName;
		},

		// Actions

		createFolder() {
			const id = generateId() as string as FolderId;
			workspaceClient.tables.folders.set({
				id,
				name: 'New Folder',
				sortOrder: folders.length,
				_v: 1,
			});
		},

		renameFolder(folderId: FolderId, name: string) {
			workspaceClient.tables.folders.update(folderId, { name });
		},

		deleteFolder(folderId: FolderId) {
			const folderNotes = allNotes.filter((n) => n.folderId === folderId);
			for (const note of folderNotes) {
				workspaceClient.tables.notes.update(note.id, {
					folderId: undefined,
				});
			}
			workspaceClient.tables.folders.delete(folderId);
			if (selectedFolderId === folderId) {
				workspaceClient.kv.set('selectedFolderId', null);
			}
		},

		createNote() {
			const id = generateId() as string as NoteId;
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
		},

		/** Soft-delete a note — moves it to Recently Deleted. */
		softDeleteNote(noteId: NoteId) {
			workspaceClient.tables.notes.update(noteId, {
				deletedAt: dateTimeStringNow(),
			});
			if (selectedNoteId === noteId) {
				workspaceClient.kv.set('selectedNoteId', null);
			}
		},

		/** Restore a soft-deleted note from Recently Deleted. */
		restoreNote(noteId: NoteId) {
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
		},

		/** Permanently delete a note — no recovery. */
		permanentlyDeleteNote(noteId: NoteId) {
			workspaceClient.tables.notes.delete(noteId);
			if (selectedNoteId === noteId) {
				workspaceClient.kv.set('selectedNoteId', null);
			}
		},

		pinNote(noteId: NoteId) {
			const note = allNotes.find((n) => n.id === noteId);
			if (!note) return;
			workspaceClient.tables.notes.update(noteId, {
				pinned: !note.pinned,
			});
		},

		selectFolder(folderId: FolderId | null) {
			isRecentlyDeletedView = false;
			workspaceClient.kv.set('selectedFolderId', folderId);
			workspaceClient.kv.set('selectedNoteId', null);
		},

		selectRecentlyDeleted() {
			isRecentlyDeletedView = true;
			workspaceClient.kv.set('selectedFolderId', null);
			workspaceClient.kv.set('selectedNoteId', null);
		},

		selectNote(noteId: NoteId) {
			workspaceClient.kv.set('selectedNoteId', noteId);
		},

		updateNoteContent({
			title,
			preview,
		}: {
			title: string;
			preview: string;
		}) {
			if (!selectedNoteId) return;
			workspaceClient.tables.notes.update(selectedNoteId, {
				title,
				preview,
			});
		},

		setSortBy(value: 'dateEdited' | 'dateCreated' | 'title') {
			workspaceClient.kv.set('sortBy', value);
		},

		setSearchQuery(query: string) {
			searchQuery = query;
		},

		/**
		 * Move a note to a different folder.
		 *
		 * Pass `undefined` to move to unfiled (remove from folder).
		 */
		moveNoteToFolder(noteId: NoteId, folderId: FolderId | undefined) {
			workspaceClient.tables.notes.update(noteId, { folderId });
		},
	};
}

export const notesState = createNotesState();
