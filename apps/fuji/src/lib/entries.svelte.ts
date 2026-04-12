/**
 * Reactive entries state for Fuji.
 *
 * Provides the active entry collection from the workspace entries table.
 * Write operations go directly through `workspace.tables.entries` or
 * `workspace.actions.entries`—no wrappers needed.
 *
 * @example
 * ```svelte
 * <script>
 *   import { entriesState } from '$lib/entries.svelte';
 * </script>
 *
 * {#each entriesState.active as entry (entry.id)}
 *   <p>{entry.title}</p>
 * {/each}
 * ```
 */

import { goto } from '$app/navigation';
import { fromTable } from '@epicenter/svelte';
import { workspace } from '$lib/client';
import type { Entry, EntryId } from '$lib/workspace';


function createEntriesState() {
	const map = fromTable(workspace.tables.entries);
	const all = $derived(map.values().toArray());
	const active = $derived(all.filter((e) => e.deletedAt === undefined));
	const deleted = $derived(all.filter((e) => e.deletedAt !== undefined));

	return {
		/** Look up an entry by ID. Returns `undefined` if not found. */
		get(id: EntryId) {
			return map.get(id);
		},

		/** Active entries—not soft-deleted. Computed once per change cycle. */
		get active() {
			return active;
		},

		/** Soft-deleted entries—has `deletedAt` set. Computed once per change cycle. */
		get deleted() {
			return deleted;
		},

		/**
		 * Create a new entry with sensible defaults and navigate to it.
		 *
		 * Delegates to the workspace `entries.create` action, then
		 * navigates to `/entries/{id}` so the editor opens immediately.
		 */
		createEntry() {
			const { id } = workspace.actions.entries.create({});
			goto(`/entries/${id}`);
		},
	};
}

export const entriesState = createEntriesState();
