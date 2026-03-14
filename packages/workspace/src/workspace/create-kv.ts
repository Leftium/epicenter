/**
 * createKv() - Lower-level API for binding KV definitions to an existing Y.Doc.
 *
 * @example
 * ```typescript
 * import * as Y from 'yjs';
 * import { createKv, defineKv } from '@epicenter/workspace';
 * import { type } from 'arktype';
 *
 * const sidebar = defineKv(type({ collapsed: 'boolean', width: 'number' }), { collapsed: false, width: 300 });
 * const fontSize = defineKv(type('number'), 14);
 *
 * const ydoc = new Y.Doc({ guid: 'my-doc' });
 * const kv = createKv(ydoc, { sidebar, fontSize });
 *
 * kv.set('sidebar', { collapsed: false, width: 300 });
 * kv.set('fontSize', 16);
 * ```
 */

import type * as Y from 'yjs';
import type {
	YKeyValueLwwChange,
	YKeyValueLwwEntry,
} from '../shared/y-keyvalue/y-keyvalue-lww.js';
import {
	createEncryptedKvLww,
	type YKeyValueLwwEncrypted,
} from '../shared/y-keyvalue/y-keyvalue-lww-encrypted.js';
import type {
	InferKvValue,
	KvChange,
	KvDefinition,
	KvDefinitions,
	KvHelper,
} from './types.js';
import { KV_KEY } from './ydoc-keys.js';

/**
 * Build a KV helper from a pre-created encrypted store.
 *
 * This is the core KV helper construction — all get/set/delete/observe logic
 * lives here. Used by `createKv` (standalone API) and `createWorkspace`
 * (which creates the store itself for encryption coordination).
 *
 * @param store - A pre-created encrypted KV store
 * @param definitions - Map of key name to KvDefinition
 * @returns KvHelper with type-safe get/set/delete/observe methods
 */
export function createKvHelper<TKvDefinitions extends KvDefinitions>(
	store: YKeyValueLwwEncrypted<unknown>,
	definitions: TKvDefinitions,
): KvHelper<TKvDefinitions> {
	return {
		get(key) {
			const definition = definitions[key];
			if (!definition) throw new Error(`Unknown KV key: ${key}`);

			const raw = store.get(key);
			if (raw === undefined) return definition.defaultValue;

			const result = definition.schema['~standard'].validate(raw);
			if (result instanceof Promise)
				throw new TypeError('Async schemas not supported');
			if (result.issues) return definition.defaultValue;

			return result.value;
		},

		set(key, value) {
			if (!definitions[key]) throw new Error(`Unknown KV key: ${key}`);
			store.set(key, value);
		},

		delete(key) {
			if (!definitions[key]) throw new Error(`Unknown KV key: ${key}`);
			store.delete(key);
		},

		observe(key, callback) {
			const definition = definitions[key];
			if (!definition) throw new Error(`Unknown KV key: ${key}`);

			const handler = (
				changes: Map<string, YKeyValueLwwChange<unknown>>,
				transaction: Y.Transaction,
			) => {
				const change = changes.get(key);
				if (!change) return;

				switch (change.action) {
					case 'delete':
						callback({ type: 'delete' }, transaction);
						break;
					case 'add':
					case 'update': {
						const result = definition.schema['~standard'].validate(
							change.newValue,
						);
						if (!(result instanceof Promise) && !result.issues) {
							callback(
								{ type: 'set', value: result.value } as Parameters<
									typeof callback
								>[0],
								transaction,
							);
						}
						// Skip callback for invalid values
						break;
					}
				}
			};

			store.observe(handler);
			return () => store.unobserve(handler);
		},

		observeAll(
			callback: (
				changes: Map<string, KvChange<unknown>>,
				transaction: unknown,
			) => void,
		) {
			const handler = (
				changes: Map<string, YKeyValueLwwChange<unknown>>,
				transaction: Y.Transaction,
			) => {
				const parsed = new Map<string, KvChange<unknown>>();
				for (const [key, change] of changes) {
					const definition = definitions[key];
					if (!definition) continue;
					if (change.action === 'delete') {
						parsed.set(key, { type: 'delete' });
					} else {
						const result = definition.schema['~standard'].validate(
							change.newValue,
						);
						if (!(result instanceof Promise) && !result.issues) {
							parsed.set(key, {
								type: 'set',
								value: result.value,
							});
						}
					}
				}
				if (parsed.size > 0) callback(parsed, transaction);
			};
			store.observe(handler);
			return () => store.unobserve(handler);
		},
	} as KvHelper<TKvDefinitions>;
}

/**
 * Binds KV definitions to an existing Y.Doc.
 *
 * Creates a KvHelper with dictionary-style access methods.
 * All KV values are stored in a shared Y.Array at `kv`.
 *
 * @param ydoc - The Y.Doc to bind KV to
 * @param definitions - Map of key name to KvDefinition
 * @returns KvHelper with type-safe get/set/delete/observe methods
 */
export function createKv<TKvDefinitions extends KvDefinitions>(
	ydoc: Y.Doc,
	definitions: TKvDefinitions,
	options?: { key?: Uint8Array },
): KvHelper<TKvDefinitions> {
	const yarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>(KV_KEY);
	const store = createEncryptedKvLww(yarray, { key: options?.key });
	return createKvHelper(store, definitions);
}

// Re-export types for convenience
export type { InferKvValue, KvDefinition, KvDefinitions, KvHelper };
