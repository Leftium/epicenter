/**
 * Reactive view state for Honeycrisp.
 *
 * Manages navigation, selection, search, sort, and view mode. Cross-cutting
 * derivations (filteredNotes, folderName, selectedNote) live here because
 * they combine data from multiple domains.
 *
 * Uses a factory function pattern to encapsulate `$state`. Observers are
 * registered once during factory construction and never cleaned up (SPA
 * lifetime).
 *
 * @example
 * ```svelte
 * <script>
 *   import { viewState } from '$lib/state';
 * </script>
 *
 * {#each viewState.filteredNotes as note (note.id)}
 *   <p>{note.title}</p>
 * {/each}
 * <p>Current folder: {viewState.folderName}</p>
 * ```
 */

import workspaceClient, { type FolderId, type NoteId } from '$lib/workspace';
import { foldersState } from './folders.svelte';
import { notesState } from './notes.svelte';

function createViewState() {
	// ─── Reactive State ──────────────────────────────────────────────────

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

	const _unobserveSelectedFolder = workspaceClient.kv.observe(
		'selectedFolderId',
		(change) => {
			selectedFolderId = change.type === 'set' ? change.value : null;
		},
	);

	const _unobserveSelectedNote = workspaceClient.kv.observe(
		'selectedNoteId',
		(change) => {
			selectedNoteId = change.type === 'set' ? change.value : null;
		},
	);

	const _unobserveSortBy = workspaceClient.kv.observe('sortBy', (change) => {
		sortBy = change.type === 'set' ? change.value : 'dateEdited';
	});

	// ─── Derived State ───────────────────────────────────────────────────

	/** Notes filtered by selected folder and search query. */
	const filteredNotes = $derived.by(() => {
		let result =
			selectedFolderId === null
				? notesState.notes
				: notesState.notes.filter((n) => n.folderId === selectedFolderId);
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

	/** Human-readable name for the current view (sidebar + NoteList header). */
	const folderName = $derived(
		isRecentlyDeletedView
			? 'Recently Deleted'
			: selectedFolderId
				? (foldersState.folders.find((f) => f.id === selectedFolderId)?.name ??
					'Notes')
				: 'All Notes',
	);

	/** The currently selected note (can be active or deleted). */
	const selectedNote = $derived(
		notesState.allNotes.find((n) => n.id === selectedNoteId) ?? null,
	);

	// ─── Public API ──────────────────────────────────────────────────────

	return {
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
		get filteredNotes() {
			return filteredNotes;
		},

		/**
		 * Select a folder and clear the note selection.
		 *
		 * Switches the view to show notes in the selected folder. If `null` is
		 * passed, shows all notes (unfiled + all folders). Also clears the
		 * Recently Deleted view if it was active.
		 *
		 * @example
		 * ```typescript
		 * viewState.selectFolder(folderId);
		 *
		 * // Show all notes
		 * viewState.selectFolder(null);
		 * ```
		 */
		selectFolder(folderId: FolderId | null) {
			isRecentlyDeletedView = false;
			workspaceClient.kv.set('selectedFolderId', folderId);
			workspaceClient.kv.set('selectedNoteId', null);
		},

		/**
		 * Switch to the Recently Deleted view.
		 *
		 * Shows only soft-deleted notes. Clears the folder selection and note
		 * selection.
		 *
		 * @example
		 * ```typescript
		 * viewState.selectRecentlyDeleted();
		 * ```
		 */
		selectRecentlyDeleted() {
			isRecentlyDeletedView = true;
			workspaceClient.kv.set('selectedFolderId', null);
			workspaceClient.kv.set('selectedNoteId', null);
		},

		/**
		 * Select a note by ID to open it in the editor.
		 *
		 * @example
		 * ```typescript
		 * viewState.selectNote(noteId);
		 * ```
		 */
		selectNote(noteId: NoteId) {
			workspaceClient.kv.set('selectedNoteId', noteId);
		},

		/**
		 * Change the note sort order.
		 *
		 * Sorts the note list by the specified criteria. The sort preference
		 * is persisted to the workspace KV store.
		 *
		 * @example
		 * ```typescript
		 * viewState.setSortBy('title');
		 * viewState.setSortBy('dateEdited');
		 * ```
		 */
		setSortBy(value: 'dateEdited' | 'dateCreated' | 'title') {
			workspaceClient.kv.set('sortBy', value);
		},

		/**
		 * Update the search filter text.
		 *
		 * Filters the note list to show only notes whose title or preview
		 * contains the search query (case-insensitive). Pass an empty string
		 * to clear the search.
		 *
		 * @example
		 * ```typescript
		 * viewState.setSearchQuery('meeting');
		 * viewState.setSearchQuery(''); // clear
		 * ```
		 */
		setSearchQuery(query: string) {
			searchQuery = query;
		},
	};
}

export const viewState = createViewState();
