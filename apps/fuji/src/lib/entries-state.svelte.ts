import { fromTable } from '@epicenter/svelte';
import type { Fuji } from '../routes/(signed-in)/fuji/browser';
import type { EntryId } from '../routes/(signed-in)/fuji/workspace';

/**
 * Reactive entries selectors derived from the fuji workspace's entries table.
 *
 * Components read this through `requireWorkspace().entries`; the active and
 * deleted lists update reactively as entries change. Disposed alongside the
 * workspace.
 */
export function createEntriesState(fuji: Fuji) {
	const entriesMap = fromTable(fuji.tables.entries);
	const active = $derived(
		[...entriesMap.values()].filter((e) => e.deletedAt === undefined),
	);
	const deleted = $derived(
		[...entriesMap.values()].filter((e) => e.deletedAt !== undefined),
	);
	return {
		get: (id: EntryId) => entriesMap.get(id),
		get active() {
			return active;
		},
		get deleted() {
			return deleted;
		},
		[Symbol.dispose]() {
			entriesMap[Symbol.dispose]();
		},
	};
}
