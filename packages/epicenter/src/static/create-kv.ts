/**
 * createKv() - Lower-level API for binding KV definitions to an existing Y.Doc.
 *
 * @example
 * ```typescript
 * import * as Y from 'yjs';
 * import { createKv, defineKv } from 'epicenter/static';
 * import { type } from 'arktype';
 *
 * const theme = defineKv(type({ mode: "'light' | 'dark'" }));
 *
 * const ydoc = new Y.Doc({ guid: 'my-doc' });
 * const kv = createKv(ydoc, { theme });
 *
 * kv.set('theme', { mode: 'dark' });
 * const result = kv.get('theme');
 * ```
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import type * as Y from 'yjs';
import {
	YKeyValueLww,
	type YKeyValueLwwChange,
	type YKeyValueLwwEntry,
} from '../core/utils/y-keyvalue-lww.js';
import type {
	InferKvValue,
	KvBatchTransaction,
	KvDefinition,
	KvDefinitions,
	KvGetResult,
	KvHelper,
} from './types.js';

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
): KvHelper<TKvDefinitions> {
	// All KV values share a single YKeyValueLww store
	const yarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>('kv');
	const ykv = new YKeyValueLww(yarray);

	/**
	 * Parse and migrate a raw value using the given definition.
	 */
	function parseValue<TValue>(
		raw: unknown,
		definition: KvDefinition<readonly StandardSchemaV1[]>,
	): KvGetResult<TValue> {
		const result = definition.schema['~standard'].validate(raw);
		if (result instanceof Promise)
			throw new TypeError('Async schemas not supported');

		if (result.issues) {
			return {
				status: 'invalid',
				errors: result.issues,
				value: raw,
			};
		}

		// Migrate to latest version
		const migrated = definition.migrate(result.value);
		return { status: 'valid', value: migrated as TValue };
	}

	return {
		get(key) {
			const definition = definitions[key];
			if (!definition) throw new Error(`Unknown KV key: ${key}`);

			const raw = ykv.get(key);
			if (raw === undefined) {
				return { status: 'not_found', value: undefined };
			}
			return parseValue(raw, definition);
		},

		set(key, value) {
			if (!definitions[key]) throw new Error(`Unknown KV key: ${key}`);
			ykv.set(key, value);
		},

		delete(key) {
			if (!definitions[key]) throw new Error(`Unknown KV key: ${key}`);
			ykv.delete(key);
		},

		batch(fn) {
			ykv.doc.transact(() => {
				fn({
					set: (key, value) => {
						if (!definitions[key]) throw new Error(`Unknown KV key: ${key}`);
						ykv.set(key, value);
					},
					delete: (key) => {
						if (!definitions[key]) throw new Error(`Unknown KV key: ${key}`);
						ykv.delete(key);
					},
				} as KvBatchTransaction<TKvDefinitions>);
			});
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

				if (change.action === 'delete') {
					callback({ type: 'delete' }, transaction);
				} else {
					// For add or update, parse and migrate the new value
					const parsed = parseValue(change.newValue, definition);
					if (parsed.status === 'valid') {
						callback(
							{ type: 'set', value: parsed.value } as Parameters<
								typeof callback
							>[0],
							transaction,
						);
					}
					// Skip callback for invalid values (could add an error callback if needed)
				}
			};

			ykv.observe(handler);
			return () => ykv.unobserve(handler);
		},
	} as KvHelper<TKvDefinitions>;
}

// Re-export types for convenience
export type { InferKvValue, KvDefinition, KvDefinitions, KvHelper };
