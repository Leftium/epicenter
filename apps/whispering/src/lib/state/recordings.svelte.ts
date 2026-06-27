/**
 * Reactive recording state backed by Yjs workspace tables.
 *
 * Replaces TanStack Query + BlobStore for recording CRUD. SvelteMap provides
 * per-key reactivity. Updating one recording doesn't re-render the entire list.
 * The Yjs observer fires on local writes, remote CRDT sync, and migration.
 *
 * Audio blob access still goes through BlobStore (blobs are too large for CRDTs).
 *
 * @example
 * ```typescript
 * import { recordings } from '$lib/state/recordings.svelte';
 *
 * // Read reactively (re-renders on change)
 * const recording = recordings.get(id);
 * const all = recordings.sorted; // newest first
 *
 * // Write (Yjs observer auto-updates SvelteMap → components re-render)
 * recordings.set(recording);
 * recordings.delete(id);
 * ```
 */
import { fromTable } from '@epicenter/svelte';
import { whispering } from '#platform/whispering';
import type { Recording } from '$lib/workspace';

/** Re-exported from the workspace definition for consumer convenience. */
export type { Recording } from '$lib/workspace';

function createRecordings() {
	const map = fromTable(whispering.tables.recordings);

	// Memoize sorted array with $derived so consumers get a stable reference.
	// `toSorted` returns a fresh sorted array (the view's `all` is a shared,
	// readonly scan, so it must not be sorted in place). The `$derived` memoizes
	// this copy, handing out a stable reference between changes. Without that
	// stability TanStack Table's $derived sees "new data" every access → updates
	// internal $state → re-triggers $derived → infinite loop.
	const sorted = $derived(
		map.all.toSorted(
			(a, b) =>
				new Date(b.recordedAt as string).getTime() -
				new Date(a.recordedAt as string).getTime(),
		),
	);

	return {
		/**
		 * All recordings as a reactive readonly table view.
		 *
		 * Components reading this re-render when recordings change.
		 * Use `.sorted` for a pre-sorted array, or iterate `.all` for
		 * custom ordering.
		 */
		get all() {
			return map;
		},

		/**
		 * Get a recording by ID. Returns undefined if not found.
		 *
		 * Reads from the reactive table view. Triggers re-render if the
		 * recording changes or is deleted.
		 */
		get(id: string) {
			return map.byId(id);
		},

		/**
		 * All recordings as a sorted array (newest first by recordedAt).
		 *
		 * Memoized via `$derived`. Returns a stable reference until the
		 * SvelteMap actually changes. This is critical for TanStack Table,
		 * which uses reference equality to detect data changes.
		 */
		get sorted(): Recording[] {
			return sorted;
		},

		/**
		 * Create or update a recording. Writes to Yjs → observer updates SvelteMap.
		 *
		 * Accepts a recording without `_v` (version tag is added automatically).
		 * No manual cache invalidation needed. The observer handles UI updates.
		 */
		set(recording: Omit<Recording, '_v'>) {
			whispering.tables.recordings.set({ ...recording } as Recording);
		},

		/**
		 * Partially update a recording by ID.
		 *
		 * Reads the current row, merges the partial fields, validates, and writes.
		 * Returns the update result for error handling.
		 */
		update(id: string, partial: Partial<Omit<Recording, 'id' | '_v'>>) {
			return whispering.tables.recordings.update(id, partial);
		},

		/**
		 * Delete a recording by ID.
		 *
		 * Fire-and-forget. Yjs observer fires `map.delete(id)` automatically.
		 * Callers should clean up audio URLs before calling this.
		 */
		delete(id: string) {
			whispering.tables.recordings.delete(id);
		},

		/**
		 * Delete multiple recordings by ID in a single optimized scan.
		 *
		 * Uses the workspace table's bulkDelete (O(n) single scan) instead of
		 * looping delete calls (O(n²)). Callers should clean up audio URLs
		 * and audio blobs separately via `services.blobs.audio.delete(ids)`.
		 */
		async bulkDelete(ids: string[]) {
			await whispering.tables.recordings.bulkDelete(ids);
		},

		/** Total number of recordings. */
		get count() {
			return map.all.length;
		},
	};
}

export const recordings = createRecordings();
