import { fromTable } from '@epicenter/svelte';
import type { EntryId } from '$lib/workspace';
import type { FujiBrowser } from '$lib/workspace/browser';

/**
 * Reactive entries selectors derived from the fuji binding's entries table.
 *
 * Components read this through `requireFuji().entries`; the active and deleted
 * lists update reactively as entries change. The conformance getters expose the
 * rows those lists hide: entries that fail the current schema or were written
 * by a newer Fuji. One `fromTable` binding drives both the row map and the
 * issue buckets from a single subscription.
 */
export function createEntriesState(fuji: FujiBrowser) {
	const entriesMap = fromTable(fuji.tables.entries);
	const active = $derived(entriesMap.all.filter((e) => e.deletedAt === null));
	const deleted = $derived(entriesMap.all.filter((e) => e.deletedAt !== null));
	return {
		get: (id: EntryId) => entriesMap.byId(id),
		get active() {
			return active;
		},
		get deleted() {
			return deleted;
		},
		/** Count of entries that parse and match the current schema. */
		get conforming() {
			return entriesMap.all.length;
		},
		/** Entries this Fuji should understand but cannot parse. */
		get nonconforming() {
			return entriesMap.nonconforming;
		},
		/** Entries written by a newer version of Fuji. */
		get newerWriter() {
			return entriesMap.newerWriter;
		},
	};
}
