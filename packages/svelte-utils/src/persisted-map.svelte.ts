import type { StandardSchemaV1 } from '@standard-schema/spec';
import { SvelteMap } from 'svelte/reactivity';
import { trySync } from 'wellcrafted/result';
import { PersistedError } from './persisted-state.svelte.js';

// ── Types ────────────────────────────────────────────────────────────────────

type PersistedMapDefinition<S extends StandardSchemaV1> = {
	/** Schema used to validate values read from storage for this key. */
	schema: S;
	/**
	 * Fallback value used when storage is empty or validation fails.
	 * Also used by `reset()` and `getDefault()`.
	 */
	defaultValue: NoInfer<StandardSchemaV1.InferOutput<S>>;
};

/** Infer the output value type from a definition. */
type InferDefinitionValue<D> =
	D extends PersistedMapDefinition<infer S>
		? StandardSchemaV1.InferOutput<S>
		: never;

type PersistedMapOptions<
	D extends Record<string, PersistedMapDefinition<StandardSchemaV1>>,
> = {
	/** Prefix for all storage keys. e.g., `'whispering.device.'` → `'whispering.device.apiKeys.openai'`. */
	prefix: string;
	/** Per-key schema and default value definitions. */
	definitions: D;
	/**
	 * The Web Storage instance to use (e.g., `localStorage`, `sessionStorage`).
	 * @default window.localStorage
	 */
	storage?: Storage;
	/**
	 * Whether to sync state across tabs via the `storage` event.
	 * Only applies to `'local'` storage.
	 * @default true
	 */
	syncTabs?: boolean;
	/**
	 * Called when a value read from storage fails to parse or validate.
	 * Fire-and-forget — `defaultValue` is used as the fallback regardless.
	 */
	onError?: (key: string, error: PersistedError) => void;
	/**
	 * Called when writing to storage fails (e.g., quota exceeded).
	 */
	onUpdateError?: (key: string, error: unknown) => void;
};

// ── Return type ──────────────────────────────────────────────────────────────

export type PersistedMapInstance<
	D extends Record<string, PersistedMapDefinition<StandardSchemaV1>>,
> = {
	get<K extends string & keyof D>(key: K): InferDefinitionValue<D[K]>;
	set<K extends string & keyof D>(
		key: K,
		value: InferDefinitionValue<D[K]>,
	): void;
	getDefault<K extends string & keyof D>(key: K): InferDefinitionValue<D[K]>;
	reset(): void;
	update(
		partial: Partial<{ [K in string & keyof D]: InferDefinitionValue<D[K]> }>,
	): void;
};

// ── createPersistedMap ───────────────────────────────────────────────────────

/**
 * Create a reactive persisted map backed by Web Storage with per-key schema validation.
 *
 * Uses `SvelteMap` for fine-grained per-key reactivity — reading one key
 * doesn't trigger re-renders for components reading another key.
 * Shares a single `storage` event listener and a single `focus` listener
 * for all keys, regardless of how many definitions exist.
 *
 * @example
 * ```ts
 * import { createPersistedMap } from '@epicenter/svelte';
 * import { type } from 'arktype';
 *
 * const config = createPersistedMap({
 *   prefix: 'myapp.config.',
 *   definitions: {
 *     'theme': { schema: type("'light' | 'dark'"), defaultValue: 'dark' },
 *     'fontSize': { schema: type('number'), defaultValue: 14 },
 *   },
 * });
 *
 * config.get('theme');           // 'dark'
 * config.set('theme', 'light');  // persists
 * config.getDefault('fontSize'); // 14
 * config.reset();                // all keys → defaults
 * ```
 */
export function createPersistedMap<
	D extends Record<string, PersistedMapDefinition<StandardSchemaV1>>,
>(options: PersistedMapOptions<D>): PersistedMapInstance<D> {
	const {
		prefix,
		definitions,
		storage: storageApi = window.localStorage,
		syncTabs = true,
		onError,
		onUpdateError,
	} = options;

	const definitionKeys = Object.keys(definitions) as (string & keyof D)[];

	function storageKey(key: string): string {
		return `${prefix}${key}`;
	}

	function isDefinitionKey(key: string): key is string & keyof D {
		return key in definitions;
	}

	/**
	 * Parse a raw JSON string from storage against a key's schema.
	 * Returns the definition's default value on any failure.
	 */
	function parseRawValue(
		key: string & keyof D,
		raw: string | null,
	): InferDefinitionValue<D[typeof key]> {
		const def = definitions[key]!;
		if (raw === null)
			return def.defaultValue as InferDefinitionValue<D[typeof key]>;

		const { data: parsed, error: jsonError } = trySync({
			try: () => JSON.parse(raw) as unknown,
			catch: (cause) => PersistedError.JsonParseFailed({ key, raw, cause }),
		});
		if (jsonError) {
			onError?.(key, jsonError);
			return def.defaultValue as InferDefinitionValue<D[typeof key]>;
		}

		const result = def.schema['~standard'].validate(parsed);
		if (result instanceof Promise) {
			onError?.(
				key,
				PersistedError.SchemaValidationFailed({
					key,
					value: parsed,
					issues: [
						{
							message:
								'Schema returned async result during synchronous validation',
						},
					],
				}).error,
			);
			return def.defaultValue as InferDefinitionValue<D[typeof key]>;
		}

		if (result.issues) {
			onError?.(
				key,
				PersistedError.SchemaValidationFailed({
					key,
					value: parsed,
					issues: result.issues,
				}).error,
			);
			return def.defaultValue as InferDefinitionValue<D[typeof key]>;
		}

		return result.value as InferDefinitionValue<D[typeof key]>;
	}

	function readKey(key: string & keyof D): InferDefinitionValue<D[typeof key]> {
		return parseRawValue(key, storageApi.getItem(storageKey(key)));
	}

	// Initialize SvelteMap from per-key storage reads.
	const map = new SvelteMap<string, unknown>();
	for (const key of definitionKeys) {
		map.set(key, readKey(key));
	}

	// Cross-tab sync: ONE listener for all keys, filtered by prefix.
	if (syncTabs) {
		window.addEventListener('storage', (e) => {
			if (!e.key?.startsWith(prefix)) return;
			const key = e.key.slice(prefix.length);
			if (!isDefinitionKey(key)) return;
			map.set(key, parseRawValue(key, e.newValue));
		});
	}

	// Same-tab sync: ONE listener for all keys.
	window.addEventListener('focus', () => {
		for (const key of definitionKeys) {
			map.set(key, readKey(key));
		}
	});

	const instance = {
		/**
		 * Get a config value. Returns the current value from the reactive SvelteMap.
		 * Components reading this will re-render when this specific key changes
		 * (not when other keys change).
		 */
		get<K extends string & keyof D>(key: K): InferDefinitionValue<D[K]> {
			return map.get(key) as InferDefinitionValue<D[K]>;
		},

		/**
		 * Set a config value. Writes to storage and updates the SvelteMap immediately.
		 * The storage write is best-effort — if it fails, the in-memory SvelteMap
		 * still updates so the UI stays responsive.
		 */
		set<K extends string & keyof D>(
			key: K,
			value: InferDefinitionValue<D[K]>,
		): void {
			try {
				storageApi.setItem(storageKey(key), JSON.stringify(value));
			} catch (error) {
				onUpdateError?.(key, error);
			}
			map.set(key, value);
		},

		/**
		 * Update multiple config keys at once. Calls `set()` for each key.
		 * Not atomic — partial writes are fine for device config.
		 */
		update(
			updates: Partial<{ [K in string & keyof D]: InferDefinitionValue<D[K]> }>,
		): void {
			for (const [key, value] of Object.entries(updates)) {
				instance.set(
					key as string & keyof D,
					value as InferDefinitionValue<D[string & keyof D]>,
				);
			}
		},

		/**
		 * Reset all config keys to their definition defaults.
		 * Writes each default value to storage.
		 */
		reset(): void {
			for (const key of definitionKeys) {
				instance.set(
					key,
					definitions[key]!.defaultValue as InferDefinitionValue<D[typeof key]>,
				);
			}
		},

		/**
		 * Get the definition's default value for a key.
		 * Useful for showing "Default: X" placeholders in settings UI.
		 */
		getDefault<K extends string & keyof D>(key: K): InferDefinitionValue<D[K]> {
			return definitions[key]!.defaultValue as InferDefinitionValue<D[K]>;
		},
	} satisfies PersistedMapInstance<D>;

	return instance;
}
