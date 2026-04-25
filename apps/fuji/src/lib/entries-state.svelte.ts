/**
 * Reactive Fuji entry state and search helpers.
 *
 * Keeps the workspace-backed entry collection and search predicate together,
 * while view preferences live in `view-state.svelte.ts`.
 *
 * @example
 * ```svelte
 * <script>
 *   import { entriesState, matchesEntrySearch } from '$lib/entries-state.svelte';
 * </script>
 * ```
 */

import { fromTable } from '@epicenter/svelte';
import { goto } from '$app/navigation';
import { actions, tables } from '$lib/client.svelte';
import type { EntryId } from '$lib/workspace';

// ─── Search ──────────────────────────────────────────────────────────────────

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
	return (
		title.includes(q) ||
		subtitle.includes(q) ||
		tags.includes(q) ||
		types.includes(q)
	);
}

// ─── Entries State ───────────────────────────────────────────────────────────

function createEntriesState() {
	const map = fromTable(tables.entries);
	const all = $derived([...map.values()]);
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
			const { id } = actions.entries.create({});
			goto(`/entries/${id}`);
		},
	};
}

export const entriesState = createEntriesState();
