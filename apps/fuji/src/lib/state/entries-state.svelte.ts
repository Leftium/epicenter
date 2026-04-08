/**
 * Reactive entries state for Fuji.
 *
 * Provides reactive entry collections (active, deleted) and UI-layer
 * operations that wrap workspace actions with view-state side-effects
 * (e.g. selecting an entry after creation, deselecting after deletion).
 *
 * Pure table CRUD lives in workspace actions (`workspace.actions.entries`).
 * This module adds the Svelte reactivity and selection management on top.
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

import { dateTimeStringNow } from '@epicenter/workspace';
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
		 * Create a new entry via workspace action and select it.
		 *
		 * Delegates to `workspace.actions.entries.create` for the actual
		 * table write, then selects the new entry so the editor opens.
		 */
		createEntry() {
			const { id } = workspace.actions.entries.create({});
			viewState.selectEntry(id);
		},

		/**
		 * Update entry fields.
		 *
		 * Thin wrapper over `tables.entries.update` — no side-effects.
		 */
		updateEntry(id: EntryId, updates: Partial<{ title: string; subtitle: string; type: string[]; tags: string[] }>) {
			workspace.tables.entries.update(id, updates);
		},

		/**
		 * Soft-delete an entry — moves it to Recently Deleted.
		 *
		 * Marks the entry with a `deletedAt` timestamp. If the deleted
		 * entry was selected, clears the selection.
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
		 * selected, clears the selection.
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
