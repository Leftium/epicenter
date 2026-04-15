/**
 * Reactive view state for Honeycrisp, backed by URL search params.
 *
 * Manages navigation, selection, search, sort, and view mode. Cross-cutting
 * derivations (filteredNotes, folderName, selectedNote) live here because
 * they combine data from multiple domains.
 *
 * State lives in the URL so it's bookmarkable, shareable, and works with
 * browser back/forward. Default values are elided from the URL to keep it
 * clean—`/` means all defaults (all notes, sorted by date edited, no search).
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

import { page } from '$app/state';
import type { FolderId, NoteId } from '$lib/workspace';
import { setSearchParam } from '$lib/search-params';
import { foldersState } from './folders.svelte';
import { notesState } from './notes.svelte';

type SortBy = 'dateEdited' | 'dateCreated' | 'title';
const SORT_KEYS: SortBy[] = ['dateEdited', 'dateCreated', 'title'];

function createViewState() {
	// ─── Derived State ───────────────────────────────────────────────────

	/** Notes filtered by selected folder and search query, then sorted. */
	const filteredNotes = $derived.by(() => {
		const folderId = (page.url.searchParams.get('folder') as FolderId) ?? null;
		const q = (page.url.searchParams.get('q') ?? '').trim().toLowerCase();
		const raw = page.url.searchParams.get('sort');
		const sort: SortBy = SORT_KEYS.includes(raw as SortBy)
			? (raw as SortBy)
			: 'dateEdited';

		return notesState.notes
			.filter((n) => folderId === null || n.folderId === folderId)
			.filter(
				(n) =>
					!q ||
					n.title.toLowerCase().includes(q) ||
					n.preview.toLowerCase().includes(q),
			)
			.toSorted((a, b) => {
				if (sort === 'title') return a.title.localeCompare(b.title);
				if (sort === 'dateCreated')
					return b.createdAt.localeCompare(a.createdAt);
				return b.updatedAt.localeCompare(a.updatedAt);
			});
	});

	/** Human-readable name for the current folder (used as NoteList title). */
	const folderName = $derived.by(() => {
		const folderId = (page.url.searchParams.get('folder') as FolderId) ?? null;
		return folderId
			? (foldersState.get(folderId)?.name ?? 'Notes')
			: 'All Notes';
	});

	/** The currently selected note (can be active or deleted). */
	const selectedNote = $derived.by(() => {
		const noteId = (page.url.searchParams.get('note') as NoteId) ?? null;
		return noteId ? (notesState.get(noteId) ?? null) : null;
	});

	// ─── Public API ──────────────────────────────────────────────────────

	return {
		get selectedFolderId(): FolderId | null {
			return (page.url.searchParams.get('folder') as FolderId) ?? null;
		},
		get selectedNoteId(): NoteId | null {
			return (page.url.searchParams.get('note') as NoteId) ?? null;
		},
		get selectedNote() {
			return selectedNote;
		},
		get searchQuery() {
			return page.url.searchParams.get('q') ?? '';
		},
		get sortBy(): SortBy {
			const raw = page.url.searchParams.get('sort');
			return SORT_KEYS.includes(raw as SortBy) ? (raw as SortBy) : 'dateEdited';
		},
		get isRecentlyDeletedView() {
			return page.url.searchParams.get('view') === 'deleted';
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
			setSearchParam('view', null);
			setSearchParam('note', null);
			setSearchParam('folder', folderId);
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
			setSearchParam('folder', null);
			setSearchParam('note', null);
			setSearchParam('view', 'deleted');
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
			setSearchParam('note', noteId);
		},

		/**
		 * Change the note sort order.
		 *
		 * Sorts the note list by the specified criteria. The default
		 * ('dateEdited') is elided from the URL to keep it clean.
		 *
		 * @example
		 * ```typescript
		 * viewState.setSortBy('title');
		 * viewState.setSortBy('dateEdited');
		 * ```
		 */
		setSortBy(value: SortBy) {
			setSearchParam('sort', value === 'dateEdited' ? null : value);
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
			setSearchParam('q', query || null);
		},
	};
}

export const viewState = createViewState();
