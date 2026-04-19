/**
 * attachKv() — Bind KV definitions to a Y.Doc.
 *
 * Constructs an unencrypted `YKeyValueLww` on `ydoc.getArray('kv')` and
 * wraps it with a typed `KvHelper`. KV uses validate-or-default semantics:
 * invalid or missing values return the default value from the KV definition.
 *
 * For encrypted storage, use `createWorkspace` from `@epicenter/workspace`.
 */

import type * as Y from 'yjs';
import type { KvChange, KvDefinitions, KvHelper } from './types.js';
import {
	YKeyValueLww,
	type YKeyValueLwwChange,
	type YKeyValueLwwEntry,
} from './y-keyvalue/index.js';

/** The Y.Array key for the KV store. */
export const KV_ARRAY_KEY = 'kv';

/**
 * Bind a record of KV definitions to a Y.Doc and return a typed KvHelper.
 *
 * @param ydoc - The Y.Doc to attach to
 * @param definitions - Map of KV key name to KvDefinition
 */
export function attachKv<TKvDefinitions extends KvDefinitions>(
	ydoc: Y.Doc,
	definitions: TKvDefinitions,
): KvHelper<TKvDefinitions> {
	const yarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>(KV_ARRAY_KEY);
	const ykv = new YKeyValueLww<unknown>(yarray);
	return kvHelperOver(ykv, definitions);
}

/**
 * Construct a KvHelper from any LWW-shaped store and a record of KV definitions.
 *
 * Exported so `@epicenter/workspace` can reuse the same helper logic over
 * its encrypted store wrapper.
 */
type KvStoreLike = {
	get(key: string): unknown;
	set(key: string, val: unknown): void;
	delete(key: string): void;
	observe(
		handler: (
			changes: Map<string, YKeyValueLwwChange<unknown>>,
			origin: unknown,
		) => void,
	): void;
	unobserve(
		handler: (
			changes: Map<string, YKeyValueLwwChange<unknown>>,
			origin: unknown,
		) => void,
	): void;
};

/**
 * Internal: build a KvHelper over any LWW-shaped store.
 */
export function kvHelperOver<TKvDefinitions extends KvDefinitions>(
	store: YKeyValueLww<unknown> | KvStoreLike,
	definitions: TKvDefinitions,
): KvHelper<TKvDefinitions> {
	const ykv: KvStoreLike =
		store instanceof YKeyValueLww ? adaptYkvLww(store) : store;

	return {
		get(key) {
			const definition = definitions[key];
			if (!definition) throw new Error(`Unknown KV key: ${key}`);

			const raw = ykv.get(key);
			if (raw === undefined) return definition.defaultValue;

			const result = definition.schema['~standard'].validate(raw);
			if (result instanceof Promise)
				throw new TypeError('Async schemas not supported');
			if (result.issues) return definition.defaultValue;

			return result.value;
		},

		set(key, value) {
			if (!definitions[key]) throw new Error(`Unknown KV key: ${key}`);
			ykv.set(key, value);
		},

		delete(key) {
			if (!definitions[key]) throw new Error(`Unknown KV key: ${key}`);
			ykv.delete(key);
		},

		observe(key, callback) {
			const definition = definitions[key];
			if (!definition) throw new Error(`Unknown KV key: ${key}`);

			const handler = (
				changes: Map<string, YKeyValueLwwChange<unknown>>,
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
				changes: Map<string, YKeyValueLwwChange<unknown>>,
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
	} as KvHelper<TKvDefinitions>;
}

/** Adapt an unencrypted YKeyValueLww to the KvStoreLike contract. */
function adaptYkvLww(ykv: YKeyValueLww<unknown>): KvStoreLike {
	const handlerMap = new WeakMap<
		(
			changes: Map<string, YKeyValueLwwChange<unknown>>,
			origin: unknown,
		) => void,
		Parameters<typeof ykv.observe>[0]
	>();
	return {
		get: (key) => ykv.get(key),
		set: (key, val) => ykv.set(key, val),
		delete: (key) => ykv.delete(key),
		observe: (handler) => {
			const inner: Parameters<typeof ykv.observe>[0] = (changes, transaction) =>
				handler(changes, transaction.origin);
			handlerMap.set(handler, inner);
			ykv.observe(inner);
		},
		unobserve: (handler) => {
			const inner = handlerMap.get(handler);
			if (inner) {
				ykv.unobserve(inner);
				handlerMap.delete(handler);
			}
		},
	};
}
