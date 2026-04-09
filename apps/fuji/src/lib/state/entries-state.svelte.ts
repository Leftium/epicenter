/**
 * Reactive entries state for Fuji.
 *
 * Provides the active entry collection and UI-layer operations that pair
 * table writes with view-state side-effects (e.g. selecting an entry
 * after creation).
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

import { fromTable } from '@epicenter/svelte';
import { workspace } from '$lib/client';
import type { EntryId } from '$lib/workspace';
import { viewState } from './view-state.svelte';

function createEntriesState() {
	// ─── Reactive Source ──────────────────────────────────────────────────
	const allEntriesMap = fromTable(workspace.tables.entries);

	const allEntries = $derived(allEntriesMap.values().toArray());

	/** Active entries — not soft-deleted. */
	const activeEntries = $derived(allEntries.filter((e) => e.deletedAt === undefined));

	// ─── Public API ──────────────────────────────────────────────────────────────────────

	return {
		get activeEntries() {
			return activeEntries;
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
	};
}

export const entriesState = createEntriesState();
