/**
 * Shared search predicate for Fuji entries.
 *
 * Used by the sidebar search results and the table's global filter
 * to ensure consistent matching semantics across views.
 */

/**
 * Test whether an entry matches a search query.
 *
 * Checks title, subtitle, tags, and type fields against a
 * case-insensitive substring match. Returns true if any field
 * contains the query.
 *
 * @example
 * ```typescript
 * const matches = matchesEntrySearch(entry, 'svelte');
 * ```
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
