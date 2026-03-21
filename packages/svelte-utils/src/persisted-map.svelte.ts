import type { StandardSchemaV1 } from '@standard-schema/spec';
import { SvelteMap } from 'svelte/reactivity';
import { trySync } from 'wellcrafted/result';
import { PersistedError } from './persisted-state.svelte.js';

// ── Types ────────────────────────────────────────────────────────────────────

type PersistedMapDefinition<S extends StandardSchemaV1> = {
	schema: S;
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

// ── Exported type (for consumers that need explicit annotations) ─────────────

/**
 * The return type of `createPersistedMap`. Exported for consumers that need
 * an explicit type annotation (e.g., to break circular dependency inference).
 *
 * Most consumers should just use `createPersistedMap(...)` and let TypeScript infer.
 */
export type PersistedMap<
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

// ── defineEntry ──────────────────────────────────────────────────────────────

/**
 * Type helper for defining a persisted map entry with schema and default value.
 * Ensures the `defaultValue` type is inferred from the schema, not the other way around.
 *
 * @example
 * ```ts
 * const DEFINITIONS = {
 *   'theme': defineEntry(type("'light' | 'dark'"), 'dark'),
 *   'fontSize': defineEntry(type('number'), 14),
 *   'deviceId': defineEntry(type('string | null'), null),
 * };
 * ```
 */
export function defineEntry<S extends StandardSchemaV1>(
	schema: S,
	defaultValue: NoInfer<StandardSchemaV1.InferOutput<S>>,
) {
	return { schema, defaultValue };
}

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
 * import { createPersistedMap, defineEntry } from '@epicenter/svelte';
 * import { type } from 'arktype';
 *
 * const config = createPersistedMap({
 *   prefix: 'myapp.config.',
 *   definitions: {
 *     'theme': defineEntry(type("'light' | 'dark'"), 'dark'),
 *     'fontSize': defineEntry(type('number'), 14),
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
>(options: PersistedMapOptions<D>) {
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

	return {
		get<K extends string & keyof D>(key: K): InferDefinitionValue<D[K]> {
			return map.get(key) as InferDefinitionValue<D[K]>;
		},

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

		update(
			updates: Partial<{ [K in string & keyof D]: InferDefinitionValue<D[K]> }>,
		): void {
			for (const [key, value] of Object.entries(updates)) {
				this.set(
					key as string & keyof D,
					value as InferDefinitionValue<D[string & keyof D]>,
				);
			}
		},

		reset(): void {
			for (const key of definitionKeys) {
				this.set(
					key,
					definitions[key]!.defaultValue as InferDefinitionValue<D[typeof key]>,
				);
			}
		},

		getDefault<K extends string & keyof D>(key: K): InferDefinitionValue<D[K]> {
			return definitions[key]!.defaultValue as InferDefinitionValue<D[K]>;
		},
	};
}
