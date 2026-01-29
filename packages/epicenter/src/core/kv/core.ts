import type * as Y from 'yjs';

import type { KvField, KvValue } from '../schema';

import { createKvHelpers, type KvChange, type KvGetResult } from './kv-helper';

/** Y.Map storing all KV values, keyed by key name. */
export type KvYMap = Y.Map<KvValue>;

export type { KvHelper } from './kv-helper';

/**
 * Minimal shape required for KV definitions - just needs a `field` property.
 * This is compatible with both the old KvDefinition wrapper and direct field usage.
 */
type KvDefinitionLike<TField extends KvField = KvField> = {
	field: TField;
};

/**
 * Flat Map-like API for accessing KV entries.
 *
 * The kv object provides direct methods: `kv.get('theme')`, `kv.set('theme', value)`.
 * This is simpler than the previous callable pattern and matches standard Map semantics.
 *
 * @example
 * ```typescript
 * kv.set('theme', 'dark');
 * kv.get('theme');  // { status: 'valid', value: 'dark' }
 * kv.reset('theme');
 * kv.has('theme');  // false (if no default)
 * ```
 */
export type KvFunction<
	TKvDefinitionMap extends Record<string, KvDefinitionLike>,
> = {
	// ════════════════════════════════════════════════════════════════════
	// KEY-VALUE OPERATIONS
	// ════════════════════════════════════════════════════════════════════

	/**
	 * Get the value for a specific KV key.
	 *
	 * Returns a discriminated union with status:
	 * - `{ status: 'valid', value }` if value exists and passes validation
	 * - `{ status: 'invalid', key, error }` if value exists but fails validation
	 * - `{ status: 'not_found', key }` if value is unset (no default, not nullable)
	 *
	 * @example
	 * ```typescript
	 * const result = kv.get('theme');
	 * if (result.status === 'valid') {
	 *   console.log(result.value); // 'dark' | 'light'
	 * }
	 * ```
	 */
	get<K extends keyof TKvDefinitionMap & string>(
		key: K,
	): KvGetResult<KvValue<TKvDefinitionMap[K]['field']>>;

	/**
	 * Set the value for a specific KV key.
	 *
	 * @example
	 * ```typescript
	 * kv.set('theme', 'dark');
	 * kv.set('count', 42);
	 * ```
	 */
	set<K extends keyof TKvDefinitionMap & string>(
		key: K,
		value: KvValue<TKvDefinitionMap[K]['field']>,
	): void;

	/**
	 * Reset a specific KV key to its default value.
	 *
	 * If a default is defined in the schema, sets to that value.
	 * If nullable with no default, sets to null.
	 * Otherwise, deletes the key entirely.
	 *
	 * @example
	 * ```typescript
	 * kv.reset('theme'); // Back to schema default
	 * ```
	 */
	reset<K extends keyof TKvDefinitionMap & string>(key: K): void;

	/**
	 * Observe changes to a specific KV key.
	 *
	 * @example
	 * ```typescript
	 * const unsubscribe = kv.observeKey('theme', (change) => {
	 *   if (change.action !== 'delete') {
	 *     document.body.className = String(change.newValue);
	 *   }
	 * });
	 * ```
	 */
	observeKey<K extends keyof TKvDefinitionMap & string>(
		key: K,
		callback: (
			change: KvChange<KvValue<TKvDefinitionMap[K]['field']>>,
			transaction: Y.Transaction,
		) => void,
	): () => void;

	// ════════════════════════════════════════════════════════════════════
	// EXISTENCE & ENUMERATION
	// ════════════════════════════════════════════════════════════════════

	/**
	 * Check if a KV key has a value set in YJS storage.
	 */
	has(key: string): boolean;

	// ════════════════════════════════════════════════════════════════════
	// BULK OPERATIONS
	// ════════════════════════════════════════════════════════════════════

	/**
	 * Clear all KV values, resetting them to their definition defaults.
	 */
	clear(): void;

	// ════════════════════════════════════════════════════════════════════
	// METADATA
	// ════════════════════════════════════════════════════════════════════

	/**
	 * The raw KV definitions passed to createKv.
	 */
	definitions: TKvDefinitionMap;

	// ════════════════════════════════════════════════════════════════════
	// OBSERVATION
	// ════════════════════════════════════════════════════════════════════

	/**
	 * Observe any KV changes. Callback is notified when any key changes.
	 */
	observe(callback: () => void): () => void;

	// ════════════════════════════════════════════════════════════════════
	// UTILITIES
	// ════════════════════════════════════════════════════════════════════

	/**
	 * Serialize all KV values to a plain JSON object.
	 */
	toJSON(): {
		[K in keyof TKvDefinitionMap]: KvValue<TKvDefinitionMap[K]['field']>;
	};
};

/**
 * Create a KV (key-value) store from definitions.
 *
 * The returned object provides a flat Map-like API with direct methods:
 * `kv.get('key')`, `kv.set('key', value)`, `kv.reset('key')`.
 *
 * Conceptually, a KV store is like a single table row where each key is a column.
 * While tables have multiple rows with IDs, KV stores have one "row" of settings/state.
 *
 * @param ydoc - The Y.Doc to store KV data in
 * @param definitions - Map of key names to their definitions (metadata + field schema)
 *
 * @example
 * ```typescript
 * import { createKv, kv, select, integer } from '@epicenter/hq';
 *
 * const settings = createKv(ydoc, {
 *   theme: kv({
 *     name: 'Theme',
 *     icon: 'emoji:🎨',
 *     field: select({ options: ['light', 'dark'], default: 'light' }),
 *     description: 'Application color theme',
 *   }),
 *   fontSize: kv({
 *     name: 'Font Size',
 *     icon: 'emoji:🔤',
 *     field: integer({ default: 14 }),
 *     description: 'Editor font size in pixels',
 *   }),
 * });
 *
 * // Flat Map-like API
 * settings.set('theme', 'dark');
 * settings.set('fontSize', 16);
 * settings.get('theme');  // { status: 'valid', value: 'dark' }
 * settings.reset('theme'); // Back to default
 * ```
 */
export function createKv<
	TKvDefinitionMap extends Record<string, KvDefinitionLike>,
>(ydoc: Y.Doc, definitions: TKvDefinitionMap): KvFunction<TKvDefinitionMap> {
	const ykvMap = ydoc.getMap<KvValue>('kv');
	const kvHelpers = createKvHelpers({ ydoc, definitions });

	return {
		// ════════════════════════════════════════════════════════════════════
		// KEY-VALUE OPERATIONS
		// ════════════════════════════════════════════════════════════════════

		/**
		 * Get the value for a specific KV key.
		 *
		 * Returns a discriminated union with status:
		 * - `{ status: 'valid', value }` if value exists and passes validation
		 * - `{ status: 'invalid', key, error }` if value exists but fails validation
		 * - `{ status: 'not_found', key }` if value is unset (no default, not nullable)
		 *
		 * @example
		 * ```typescript
		 * const result = kv.get('theme');
		 * if (result.status === 'valid') {
		 *   console.log(result.value); // 'dark' | 'light'
		 * }
		 * ```
		 */
		get<K extends keyof TKvDefinitionMap & string>(key: K) {
			return kvHelpers[key].get();
		},

		/**
		 * Set the value for a specific KV key.
		 *
		 * @example
		 * ```typescript
		 * kv.set('theme', 'dark');
		 * kv.set('count', 42);
		 * ```
		 */
		set<K extends keyof TKvDefinitionMap & string>(
			key: K,
			value: KvValue<TKvDefinitionMap[K]['field']>,
		) {
			kvHelpers[key].set(value);
		},

		/**
		 * Reset a specific KV key to its default value.
		 *
		 * If a default is defined in the schema, sets to that value.
		 * If nullable with no default, sets to null.
		 * Otherwise, deletes the key entirely.
		 *
		 * @example
		 * ```typescript
		 * kv.reset('theme'); // Back to schema default
		 * ```
		 */
		reset<K extends keyof TKvDefinitionMap & string>(key: K) {
			kvHelpers[key].reset();
		},

		/**
		 * Observe changes to a specific KV key.
		 *
		 * @example
		 * ```typescript
		 * const unsubscribe = kv.observeKey('theme', (change) => {
		 *   if (change.action !== 'delete') {
		 *     document.body.className = String(change.newValue);
		 *   }
		 * });
		 * ```
		 */
		observeKey<K extends keyof TKvDefinitionMap & string>(
			key: K,
			callback: (
				change: KvChange<KvValue<TKvDefinitionMap[K]['field']>>,
				transaction: Y.Transaction,
			) => void,
		) {
			return kvHelpers[key].observe(callback);
		},

		// ════════════════════════════════════════════════════════════════════
		// EXISTENCE & ENUMERATION
		// ════════════════════════════════════════════════════════════════════

		/**
		 * Check if a KV key has a value set in YJS storage.
		 *
		 * Returns true if a value has been explicitly set (even if it's null).
		 * Returns false if the key has never been set (will use default).
		 *
		 * @example
		 * ```typescript
		 * kv.has('theme')  // false (never set, will use default)
		 * kv.set('theme', 'dark')
		 * kv.has('theme')  // true
		 * ```
		 */
		has(key: string): boolean {
			return ykvMap.has(key);
		},

		// ════════════════════════════════════════════════════════════════════
		// BULK OPERATIONS
		// ════════════════════════════════════════════════════════════════════

		/**
		 * Clear all KV values, resetting them to their definition defaults.
		 *
		 * Deletes all keys from the underlying Y.Map. After clearing,
		 * `get()` will return defaults (if defined), `null` (if nullable),
		 * or `not_found` status.
		 *
		 * @example
		 * ```typescript
		 * kv.set('theme', 'dark');
		 * kv.set('fontSize', 20);
		 *
		 * kv.clear();
		 *
		 * kv.get('theme');    // { status: 'valid', value: 'light' } (default)
		 * kv.get('fontSize'); // { status: 'valid', value: 14 } (default)
		 * ```
		 */
		clear(): void {
			for (const keyName of Object.keys(definitions)) {
				ykvMap.delete(keyName);
			}
		},

		// ════════════════════════════════════════════════════════════════════
		// METADATA & ESCAPE HATCHES
		// ════════════════════════════════════════════════════════════════════

		/**
		 * The raw KV definitions passed to createKv.
		 *
		 * Provides access to the full definition including metadata (name, icon, description)
		 * and the field schema. Useful for introspection, UI generation, or MCP/OpenAPI export.
		 *
		 * @example
		 * ```typescript
		 * // Access definition metadata
		 * console.log(kv.definitions.theme.name);        // 'Theme'
		 * console.log(kv.definitions.theme.icon);        // 'emoji:🎨'
		 * console.log(kv.definitions.theme.description); // 'Application color theme'
		 *
		 * // Access the field schema
		 * console.log(kv.definitions.theme.field.type);    // 'select'
		 * console.log(kv.definitions.theme.field.options); // ['light', 'dark']
		 *
		 * // Iterate over all definitions
		 * for (const [key, def] of Object.entries(kv.definitions)) {
		 *   console.log(`${def.name} (${key}): ${def.field.type}`);
		 * }
		 * ```
		 */
		definitions,

		// ════════════════════════════════════════════════════════════════════
		// OBSERVATION
		// ════════════════════════════════════════════════════════════════════

		/**
		 * Observe any KV changes. Callback is notified when any key changes.
		 *
		 * The observer just notifies that something changed. To get the current
		 * state, call `toJSON()` inside your callback or use individual key getters.
		 *
		 * @returns Unsubscribe function to stop observing
		 *
		 * @example
		 * ```typescript
		 * const unsubscribe = kv.observe(() => {
		 *   // Something changed - fetch current state if needed
		 *   const snapshot = kv.toJSON();
		 *   saveToFile(snapshot);
		 * });
		 *
		 * // Later, stop observing
		 * unsubscribe();
		 * ```
		 */
		observe(callback: () => void): () => void {
			ykvMap.observeDeep(callback);
			return () => ykvMap.unobserveDeep(callback);
		},

		// ════════════════════════════════════════════════════════════════════
		// UTILITIES
		// ════════════════════════════════════════════════════════════════════

		/**
		 * Serialize all KV values to a plain JSON object.
		 *
		 * Returns the raw Y.Map contents. Keys may be missing if never set,
		 * and values may not match the schema (no validation performed).
		 * Useful for debugging, persistence, or API responses.
		 *
		 * @example
		 * ```typescript
		 * kv.set('theme', 'dark');
		 * kv.set('fontSize', 16);
		 *
		 * const json = kv.toJSON();
		 * // { theme: 'dark', fontSize: 16 }
		 *
		 * // Save to localStorage
		 * localStorage.setItem('settings', JSON.stringify(kv.toJSON()));
		 * ```
		 */
		toJSON(): {
			[K in keyof TKvDefinitionMap]: KvValue<TKvDefinitionMap[K]['field']>;
		} {
			return ykvMap.toJSON() as {
				[K in keyof TKvDefinitionMap]: KvValue<TKvDefinitionMap[K]['field']>;
			};
		},
	};
}

/**
 * Type alias for the return type of createKv.
 * Useful for typing function parameters that accept a KV instance.
 */
export type Kv<TKvDefinitionMap extends Record<string, KvDefinitionLike>> =
	ReturnType<typeof createKv<TKvDefinitionMap>>;
