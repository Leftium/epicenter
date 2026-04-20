/**
 * attachKv() — Bind KV definitions to a Y.Doc.
 *
 * Constructs an unencrypted `YKeyValueLww` on `ydoc.getArray('kv')` and
 * wraps it with a typed `Kv`. KV uses validate-or-default semantics:
 * invalid or missing values return the default value from the KV definition.
 *
 * For encrypted storage, use `createWorkspace` from `@epicenter/workspace`.
 */

import type * as Y from 'yjs';
import { KV_KEY } from './keys.js';
import type { Kv, KvDefinitions, KvChange } from './types.js';
import {
	type KvStoreChange,
	type ObservableKvStore,
	YKeyValueLww,
	type YKeyValueLwwEntry,
} from './y-keyvalue/index.js';

/**
 * Bind a record of KV definitions to a Y.Doc and return a typed Kv.
 *
 * @param ydoc - The Y.Doc to attach to
 * @param definitions - Map of KV key name to KvDefinition
 */
export function attachKv<TKvDefinitions extends KvDefinitions>(
	ydoc: Y.Doc,
	definitions: TKvDefinitions,
): Kv<TKvDefinitions> {
	const yarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>(KV_KEY);
	const ykv = new YKeyValueLww<unknown>(yarray);
	ydoc.on('destroy', () => ykv.dispose());
	return createKv(ykv, definitions);
}

/**
 * Build a Kv helper over any `ObservableKvStore`. Exported so
 * `@epicenter/workspace` can reuse the same helper logic over its encrypted
 * store wrapper.
 */
export function createKv<TKvDefinitions extends KvDefinitions>(
	ykv: ObservableKvStore<unknown>,
	definitions: TKvDefinitions,
): Kv<TKvDefinitions> {
	return {
		get(key) {
			const definition = definitions[key]!;
			const raw = ykv.get(key);
			if (raw === undefined) return definition.defaultValue;

			const result = definition.schema['~standard'].validate(raw);
			if (result instanceof Promise)
				throw new TypeError('Async schemas not supported');
			if (result.issues) return definition.defaultValue;

			return result.value;
		},

		set(key, value) {
			ykv.set(key, value);
		},

		delete(key) {
			ykv.delete(key);
		},

		observe(key, callback) {
			const definition = definitions[key]!;

			const handler = (
				changes: Map<string, KvStoreChange<unknown>>,
				origin: unknown,
			) => {
				const change = changes.get(key);
				if (!change) return;

				switch (change.action) {
					case 'delete':
						callback({ type: 'delete' }, origin);
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
								origin,
							);
						}
						// Skip callback for invalid values
						break;
					}
				}
			};

			ykv.observe(handler);
			return () => ykv.unobserve(handler);
		},

		observeAll(
			callback: (
				changes: Map<string, KvChange<unknown>>,
				origin: unknown,
			) => void,
		) {
			const handler = (
				changes: Map<string, KvStoreChange<unknown>>,
				origin: unknown,
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
				if (parsed.size > 0) callback(parsed, origin);
			};
			ykv.observe(handler);
			return () => ykv.unobserve(handler);
		},

		getAll() {
			const result: Record<string, unknown> = {};
			for (const key of Object.keys(definitions)) {
				result[key] = this.get(key);
			}
			return result;
		},
	} as Kv<TKvDefinitions>;
}
