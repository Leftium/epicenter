/**
 * Epoch Tracker — coordination primitive for epoch-based Y.Doc compaction.
 *
 * The epoch is stored as a `Y.Map<number>('epoch')` where keys are stringified
 * client IDs and values are epoch numbers. The current epoch is `MAX(all values)`,
 * defaulting to 0 when the map is empty.
 *
 * This enables CRDT-safe concurrent epoch bumps: each client writes only its own
 * key, and readers take the maximum. Two clients bumping simultaneously both write
 * the same next value under different keys, and MAX still converges.
 *
 * This module is internal to `createWorkspace()`—not exported from the package barrel.
 */

import type * as Y from 'yjs';

/**
 * Create an epoch tracker backed by a Y.Map on the given Y.Doc.
 *
 * The tracker reads and writes a `Y.Map<number>('epoch')` where keys are
 * `ydoc.clientID.toString()` and values are epoch numbers. The current
 * epoch is the maximum of all values in the map (0 when empty).
 *
 * @param ydoc - The coordination Y.Doc that holds the epoch map
 *
 * @example
 * ```typescript
 * const coordYdoc = new Y.Doc({ guid: workspaceId });
 * const tracker = createEpochTracker(coordYdoc);
 *
 * tracker.getEpoch();  // 0
 * tracker.bumpEpoch(); // 1
 * tracker.getEpoch();  // 1
 * ```
 */
export function createEpochTracker(ydoc: Y.Doc) {
	const epochMap = ydoc.getMap<number>('epoch');

	return {
		/** The underlying Y.Doc for the coordination doc. */
		ydoc,

		/**
		 * Get the current epoch (MAX of all client proposals).
		 *
		 * Iterates every client's proposed epoch and returns the maximum.
		 * Returns 0 if no client has bumped the epoch yet.
		 *
		 * @example
		 * ```typescript
		 * const epoch = tracker.getEpoch(); // 3
		 * const dataGuid = `${workspaceId}-${epoch}`;
		 * ```
		 */
		getEpoch(): number {
			let max = 0;
			epochMap.forEach((value) => {
				max = Math.max(max, value);
			});
			return max;
		},

		/**
		 * Bump to the next epoch.
		 *
		 * Computes `MAX(all proposals) + 1` and writes it under this
		 * client's ID. Safe for concurrent bumps—two clients bumping
		 * simultaneously will both write the same next value under
		 * different keys, and MAX still converges.
		 *
		 * @returns The new epoch number
		 */
		bumpEpoch(): number {
			const next = this.getEpoch() + 1;
			epochMap.set(ydoc.clientID.toString(), next);
			return next;
		},

		/**
		 * Observe epoch changes.
		 *
		 * Fires whenever any client's epoch value changes in the map.
		 * The callback receives the new MAX epoch.
		 *
		 * @returns Unsubscribe function
		 */
		observeEpoch(callback: (epoch: number) => void): () => void {
			const handler = () => callback(this.getEpoch());
			epochMap.observe(handler);
			return () => epochMap.unobserve(handler);
		},
	};
}
