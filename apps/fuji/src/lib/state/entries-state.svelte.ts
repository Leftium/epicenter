/**
 * Reactive entries state for Fuji.
 *
 * Manages entry CRUD operations, soft deletion, pinning, and reactive
 * entry collections. Backed by a Y.Doc CRDT table, so entries sync
 * across devices. Uses a factory function pattern to encapsulate `$state`.
 *
 * Observers are registered once during factory construction and never
 * cleaned up (SPA lifetime).
 *
 * @example
 * ```svelte
 * <script>
 *   import { entriesState } from '$lib/state/entries-state.svelte';
 * </script>
 *
 * {#each entriesState.activeEntries as entry (entry.id)}
 *   <p>{entry.title}</p>
 * {/each}
 * <button onclick={() => entriesState.createEntry()}>New Entry</button>
 * ```
 */

import { dateTimeStringNow, generateId } from '@epicenter/workspace';
import { fromTable } from '@epicenter/svelte';
import { workspace } from '$lib/client';
import type { EntryId } from '$lib/workspace';
import { viewState } from './view-state.svelte';

function createEntriesState() {
	// ─── Reactive Source ──────────────────────────────────────────────────
	const allEntriesMap = fromTable(workspace.tables.entries);

	/** All entries (including soft-deleted). Cached via $derived. */
	const allEntries = $derived(allEntriesMap.values().toArray());

	// ─── Derived State ───────────────────────────────────────────────────

	/** Active entries — not soft-deleted. */
	const activeEntries = $derived(allEntries.filter((e) => e.deletedAt === undefined));

	/** Soft-deleted entries for the Recently Deleted view. */
	const deletedEntries = $derived(allEntries.filter((e) => e.deletedAt !== undefined));

	// ─── Public API ──────────────────────────────────────────────────────

	return {
		get allEntries() {
			return allEntries;
		},
		get activeEntries() {
			return activeEntries;
		},
		get deletedEntries() {
			return deletedEntries;
		},

		/**
		 * Look up an entry by ID.
		 *
		 * Returns the entry row or undefined if it doesn't exist. O(1) via
		 * SvelteMap lookup — no iteration needed.
		 */
		get(id: EntryId) {
			return allEntriesMap.get(id);
		},

		/**
		 * Create a new entry and select it.
		 *
		 * The entry starts with an empty title, subtitle, and content.
		 * It's automatically selected after creation so the editor opens
		 * immediately.
		 */
		createEntry() {
			const id = generateId() as unknown as EntryId;
			workspace.tables.entries.set({
				id,
				title: '',
				subtitle: '',
				type: [],
				tags: [],
				pinned: false,
				deletedAt: undefined,
				createdAt: dateTimeStringNow(),
				updatedAt: dateTimeStringNow(),
				_v: '1',
			});
			viewState.selectEntry(id);
		},

		/**
		 * Update entry fields.
		 *
		 * Accepts a partial update — only the provided fields are changed.
		 * Commonly used by the editor to update title, subtitle, type, and tags.
		 */
		updateEntry(id: EntryId, updates: Partial<{ title: string; subtitle: string; type: string[]; tags: string[] }>) {
			workspace.tables.entries.update(id, updates);
		},

		/**
		 * Soft-delete an entry — moves it to Recently Deleted.
		 *
		 * The entry is marked with a `deletedAt` timestamp but not permanently
		 * removed. It can be restored later. If the deleted entry was selected,
		 * the selection is cleared.
		 */
		softDeleteEntry(id: EntryId) {
			workspace.tables.entries.update(id, { deletedAt: dateTimeStringNow() });
			if (viewState.selectedEntryId === id) {
				viewState.selectEntry(null);
			}
		},

		/**
		 * Restore a soft-deleted entry.
		 *
		 * Removes the `deletedAt` timestamp so the entry reappears in the
		 * active entries list.
		 */
		restoreEntry(id: EntryId) {
			workspace.tables.entries.update(id, { deletedAt: undefined });
		},

		/**
		 * Toggle the pinned state of an entry.
		 *
		 * Pinned entries appear at the top of lists. If the entry doesn't
		 * exist, the operation is silently ignored.
		 */
		togglePin(id: EntryId) {
			const entry = allEntriesMap.get(id);
			if (!entry) return;
			workspace.tables.entries.update(id, { pinned: !entry.pinned });
		},

		/**
		 * Permanently delete an entry — no recovery.
		 *
		 * Removes the entry from the CRDT entirely. If the deleted entry was
		 * selected, the selection is cleared.
		 */
		permanentlyDeleteEntry(id: EntryId) {
			workspace.tables.entries.delete(id);
			if (viewState.selectedEntryId === id) {
				viewState.selectEntry(null);
			}
		},
	};
}

export const entriesState = createEntriesState();
