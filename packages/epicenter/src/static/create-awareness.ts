/**
 * createAwareness() - Wraps a raw Awareness instance with typed helpers.
 *
 * Uses the record-of-fields pattern (same as tables and KV). Each field has its own
 * StandardSchemaV1 schema. Validation happens per-field on read (`getAll()`), not on write.
 *
 * ## API Design
 *
 * Both `setLocal()` (merge all fields) and `setLocalField()` (update one field) are provided.
 * `setLocal()` merges into current state — it does NOT replace. This matches the mental model
 * of "set these fields" and prevents accidentally losing fields.
 *
 * `setLocalField()` maps directly to y-protocols `setLocalStateField()` for single-field updates.
 *
 * ## Validation Strategy
 *
 * - **On write** (`setLocal`, `setLocalField`): Compile-time only (TypeScript).
 *   Local code, own TypeScript — runtime validation is pure overhead.
 * - **On read** (`getAll`): Per-field schema validation. Remote peers can't be trusted.
 *   Each field is independently validated; invalid fields are omitted but valid fields
 *   from the same client are still included.
 *
 * @example
 * ```typescript
 * import * as Y from 'yjs';
 * import { createAwareness } from 'epicenter/static';
 * import { type } from 'arktype';
 *
 * const ydoc = new Y.Doc({ guid: 'my-doc' });
 * const awareness = createAwareness(ydoc, {
 *   deviceId: type('string'),
 *   deviceType: type('"browser-extension" | "desktop" | "server" | "cli"'),
 * });
 *
 * // Set all fields at once (merge)
 * awareness.setLocal({ deviceId: 'abc', deviceType: 'desktop' });
 *
 * // Update a single field
 * awareness.setLocalField('deviceType', 'server');
 *
 * // Get a single field
 * const myType = awareness.getLocalField('deviceType');
 * // ^? 'browser-extension' | 'desktop' | 'server' | 'cli' | undefined
 *
 * // Get all peers (per-field validated, invalid fields skipped)
 * const peers = awareness.getAll();
 * // ^? Map<number, { deviceId?: string; deviceType?: string }>
 * ```
 */

import { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import type {
	AwarenessDefinitions,
	AwarenessHelper,
	AwarenessState,
} from './types.js';

/**
 * Creates an AwarenessHelper from a Y.Doc and a record of field schemas.
 *
 * The Awareness instance is created internally. Each field gets its own StandardSchemaV1
 * schema for independent validation on read.
 *
 * @param ydoc - The Y.Doc to create awareness for
 * @param definitions - Record of field name → StandardSchemaV1 schema
 * @returns AwarenessHelper with typed per-field methods
 */
export function createAwareness<TDefs extends AwarenessDefinitions>(
	ydoc: Y.Doc,
	definitions: TDefs,
): AwarenessHelper<TDefs> {
	const raw = new Awareness(ydoc);
	const defEntries = Object.entries(definitions);

	return {
		setLocal(state) {
			// Merge with current state (partial update, like setLocalStateField for each key)
			const current = raw.getLocalState() ?? {};
			raw.setLocalState({ ...current, ...state });
		},

		setLocalField(key, value) {
			raw.setLocalStateField(key, value);
		},

		getLocal() {
			return raw.getLocalState() as AwarenessState<TDefs> | null;
		},

		getLocalField(key) {
			const state = raw.getLocalState();
			if (state === null) return undefined;
			return (state as Record<string, unknown>)[key] as ReturnType<
				AwarenessHelper<TDefs>['getLocalField']
			>;
		},

		getAll() {
			const result = new Map<number, AwarenessState<TDefs>>();

			for (const [clientId, state] of raw.getStates()) {
				if (state === null || typeof state !== 'object') continue;

				// Validate each field independently against its schema
				const validated: Record<string, unknown> = {};
				for (const [fieldKey, fieldSchema] of defEntries) {
					const fieldValue = (state as Record<string, unknown>)[fieldKey];
					if (fieldValue === undefined) continue;

					const fieldResult = fieldSchema['~standard'].validate(fieldValue);
					if (fieldResult instanceof Promise) continue; // Skip async schemas
					if (fieldResult.issues) continue; // Skip invalid fields

					validated[fieldKey] = fieldResult.value;
				}

				// Skip clients with zero valid fields
				if (Object.keys(validated).length > 0) {
					result.set(clientId, validated as AwarenessState<TDefs>);
				}
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

// Re-export types for convenience
export type { AwarenessHelper };
