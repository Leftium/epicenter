/**
 * Reactive entries state for Fuji.
 *
 * Provides the active entry collection from the workspace entries table.
 * Write operations go directly through `workspace.tables.entries` or
 * `workspace.actions.entries`—no wrappers needed.
 */

import { fromTable } from '@epicenter/svelte';
import { workspace } from '$lib/client';

function createEntriesState() {
	const map = fromTable(workspace.tables.entries);
	const all = $derived(map.values().toArray());
	const active = $derived(all.filter((e) => e.deletedAt === undefined));

	return {
		/**
		 * Reactive map of all entries by ID.
		 *
		 * Backed by `fromTable()` SvelteMap—lookups are O(1) and
		 * reactive in Svelte 5 templates and `$derived` expressions.
		 */
		map,

		/** Active entries—not soft-deleted. Computed once per change cycle. */
		get active() {
			return active;
		},
	};
}

export const entries = createEntriesState();
