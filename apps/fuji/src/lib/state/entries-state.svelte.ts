/**
 * Reactive entries state for Fuji.
 *
 * Provides the active entry collection from the workspace entries table.
 * Write operations go directly through `workspace.tables.entries` or
 * `workspace.actions.entries`—no wrappers needed.
 */

import { fromTable } from '@epicenter/svelte';
import { workspace } from '$lib/client';
import type { EntryId } from '$lib/workspace/definition';
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
		 * Reactive map of all entries by ID.
		 *
		 * Backed by `fromTable()` SvelteMap—lookups are O(1) and
		 * reactive in Svelte 5 templates and `$derived` expressions.
		 */
		get entriesMap() {
			return allEntriesMap;
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
	};
}

export const entriesState = createEntriesState();
