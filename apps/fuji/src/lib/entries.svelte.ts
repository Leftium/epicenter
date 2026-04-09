/**
 * Reactive entries state for Fuji.
 *
 * Provides the active entry collection from the workspace entries table.
 * Write operations go directly through `workspace.tables.entries` or
 * `workspace.actions.entries`—no wrappers needed.
 */

import { fromTable } from '@epicenter/svelte';
import { workspace } from '$lib/client';

/**
 * Reactive map of all entries by ID.
 *
 * Backed by `fromTable()` SvelteMap—lookups are O(1) and
 * reactive in Svelte 5 templates and `$derived` expressions.
 */
export const entriesMap = fromTable(workspace.tables.entries);

const allEntries = $derived(entriesMap.values().toArray());

/** Active entries — not soft-deleted. */
export const activeEntries = $derived(allEntries.filter((e) => e.deletedAt === undefined));
