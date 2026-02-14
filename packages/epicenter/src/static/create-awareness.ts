/**
 * createAwareness() - Wraps a raw Awareness instance with typed helpers.
 *
 * ## Design: Full-State Updates Only
 *
 * This wrapper intentionally exposes only `setLocal()` (full state replacement),
 * not `setLocalStateField()` (individual field updates). Here's why:
 *
 * **Performance: Identical**
 * - `setLocalStateField()` internally calls `setLocalState()` after spreading the existing state
 * - Source: https://github.com/yjs/y-protocols/blob/master/src/awareness.js#L106-L154
 * - Both increment the awareness clock and trigger network propagation identically
 * - The "overhead" of object spreading is negligible (nanoseconds in JS)
 *
 * **Simplicity: Better API**
 * - Full replacement ensures no stale fields linger
 * - Clear mental model: "this is my complete state"
 * - Matches Epicenter's table pattern (`.upsert()` replaces entire rows)
 * - TypeScript ensures the state shape is always correct
 *
 * **When Would You Need Field Updates?**
 * - High-frequency ephemeral state (cursor position updating 100x/sec)
 * - Mix of stable fields (user info) and rapidly changing fields (cursor)
 * - In practice: Epicenter awareness is typically stable identity (`{ deviceId, type }`)
 *
 * **How to Update a Single Field Manually:**
 * ```typescript
 * const current = awareness.getLocal()!;
 * awareness.setLocal({ ...current, newField: value });
 * ```
 *
 * This is functionally identical to what `setLocalStateField()` does internally,
 * just more explicit. No performance penalty.
 *
 * @example
 * ```typescript
 * import * as Y from 'yjs';
 * import { createAwareness } from 'epicenter/static';
 * import { type } from 'arktype';
 *
 * const schema = type({
 *   deviceId: 'string',
 *   type: '"browser-extension" | "desktop" | "server" | "cli"',
 * });
 *
 * const ydoc = new Y.Doc({ guid: 'my-doc' });
 * const awareness = createAwareness(ydoc, schema);
 *
 * // Initialize awareness (full state)
 * awareness.setLocal({ deviceId: 'abc', type: 'desktop' });
 *
 * // Get all peers (validated, invalid states skipped)
 * const peers = awareness.getAll();
 * // ^? Map<number, { deviceId: string; type: 'browser-extension' | 'desktop' | 'server' | 'cli' }>
 *
 * // Update (manual spread if needed)
 * const current = awareness.getLocal()!;
 * awareness.setLocal({ ...current, type: 'server' });
 * ```
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import type { AwarenessHelper } from './types.js';

/**
 * Creates an AwarenessHelper from a Y.Doc and schema.
 *
 * The Awareness instance is created internally and wrapped with schema-validated helpers.
 * No defineAwareness() wrapper needed — pass raw StandardSchemaV1 schema directly.
 *
 * @param ydoc - The Y.Doc to create awareness for
 * @param schema - Raw StandardSchemaV1 schema for awareness state (no wrapper)
 * @returns AwarenessHelper with typed methods
 */
export function createAwareness<TState>(
	ydoc: Y.Doc,
	schema: StandardSchemaV1<unknown, TState>,
): AwarenessHelper<TState> {
	const raw = new Awareness(ydoc);

	return {
		/**
		 * Set this client's awareness state (atomic replacement).
		 *
		 * This method replaces the ENTIRE local awareness state and broadcasts
		 * it to all connected peers. It does NOT merge with existing state.
		 *
		 * **Why no `setField()` method?**
		 * - Identical performance (setLocalStateField internally calls setLocalState)
		 * - Simpler API (no confusion about merging vs replacing)
		 * - Matches table pattern (upsert replaces entire rows)
		 * - Manual spread is trivial: `setLocal({ ...getLocal()!, field: value })`
		 *
		 * @param state - Complete awareness state matching the schema
		 *
		 * @example
		 * ```typescript
		 * // Initial setup
		 * awareness.setLocal({ deviceId: 'abc', type: 'desktop' });
		 *
		 * // Update entire state
		 * awareness.setLocal({ deviceId: 'abc', type: 'server' });
		 *
		 * // Update one field (manual spread)
		 * const current = awareness.getLocal()!;
		 * awareness.setLocal({ ...current, type: 'browser-extension' });
		 * ```
		 */
		setLocal(state: TState) {
			raw.setLocalState(state);
		},

		getLocal(): TState | null {
			return raw.getLocalState() as TState | null;
		},

		getAll(): Map<number, TState> {
			const result = new Map<number, TState>();
			for (const [clientId, state] of raw.getStates()) {
				// Validate against schema — skip invalid
				const validated = schema['~standard'].validate(state);
				if (validated.issues) continue;
				result.set(clientId, validated.value as TState);
			}
			return result;
		},

		observe(callback) {
			const handler = ({
				added,
				updated,
				removed,
			}: {
				added: number[];
				updated: number[];
				removed: number[];
			}) => {
				const changes = new Map<number, 'added' | 'updated' | 'removed'>();
				for (const id of added) changes.set(id, 'added');
				for (const id of updated) changes.set(id, 'updated');
				for (const id of removed) changes.set(id, 'removed');
				callback(changes);
			};
			raw.on('change', handler);
			return () => raw.off('change', handler);
		},

		raw,
	};
}

// Re-export type for convenience
export type { AwarenessHelper };
