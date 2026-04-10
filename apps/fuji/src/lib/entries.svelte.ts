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

import { fromTable } from '@epicenter/svelte';
import { workspace } from '$lib/client';

/**
 * Test whether an entry matches a search query.
 *
 * Checks title, subtitle, tags, and type fields against a
 * case-insensitive substring match. Returns true if any field
 * contains the query.
 */
export function matchesEntrySearch(
	entry: { title: string; subtitle: string; tags: string[]; type: string[] },
	query: string,
): boolean {
	const q = query.trim().toLowerCase();
	if (!q) return false;
	const title = entry.title.toLowerCase();
	const subtitle = entry.subtitle.toLowerCase();
	const tags = entry.tags.join(' ').toLowerCase();
	const types = entry.type.join(' ').toLowerCase();
	return title.includes(q) || subtitle.includes(q) || tags.includes(q) || types.includes(q);
}

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

export const entriesState = createEntriesState();
