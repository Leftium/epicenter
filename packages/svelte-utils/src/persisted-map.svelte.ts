import type { StandardSchemaV1 } from '@standard-schema/spec';
import { SvelteMap } from 'svelte/reactivity';
import { trySync } from 'wellcrafted/result';
import { PersistedError } from './persisted-state.svelte.js';

// ── Types ────────────────────────────────────────────────────────────────────

type PersistedMapDefinition<TSchema extends StandardSchemaV1> = {
	schema: TSchema;
	defaultValue: NoInfer<StandardSchemaV1.InferOutput<TSchema>>;
};

type InferDefinitionValue<TDef> =
	TDef extends PersistedMapDefinition<infer TSchema>
		? StandardSchemaV1.InferOutput<TSchema>
		: never;

type PersistedMapOptions<
	TDefs extends Record<string, PersistedMapDefinition<StandardSchemaV1>>,
> = {
	/** Prefix for all storage keys. e.g., `'whispering.device.'` → `'whispering.device.apiKeys.openai'`. */
	prefix: string;
	/** Per-key schema and default value definitions. */
	definitions: TDefs;
	/**
	 * The Web Storage instance to use.
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

/**
 * Return type of `createPersistedMap`. Exported for consumers that need
 * an explicit type annotation (e.g., to break circular dependency inference).
 */
export type PersistedMap<
	TDefs extends Record<string, PersistedMapDefinition<StandardSchemaV1>>,
> = {
	get<TKey extends string & keyof TDefs>(
		key: TKey,
	): InferDefinitionValue<TDefs[TKey]>;
	set<TKey extends string & keyof TDefs>(
		key: TKey,
		value: InferDefinitionValue<TDefs[TKey]>,
	): void;
	getDefault<TKey extends string & keyof TDefs>(
		key: TKey,
	): InferDefinitionValue<TDefs[TKey]>;
	reset(): void;
	update(
		partial: Partial<{
			[TKey in string & keyof TDefs]: InferDefinitionValue<TDefs[TKey]>;
		}>,
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
export function defineEntry<TSchema extends StandardSchemaV1>(
	schema: TSchema,
	defaultValue: NoInfer<StandardSchemaV1.InferOutput<TSchema>>,
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
	TDefs extends Record<string, PersistedMapDefinition<StandardSchemaV1>>,
>({
	prefix,
	definitions,
	storage: storageApi = window.localStorage,
	syncTabs = true,
	onError,
	onUpdateError,
}: PersistedMapOptions<TDefs>) {
	const definitionKeys = Object.keys(definitions) as (string & keyof TDefs)[];

	function storageKey(key: string) {
		return `${prefix}${key}`;
	}

	function isDefinitionKey(key: string): key is string & keyof TDefs {
		return key in definitions;
	}

	function parseRawValue(key: string & keyof TDefs, raw: string | null) {
		const def = definitions[key]!;
		if (raw === null)
			return def.defaultValue as InferDefinitionValue<TDefs[typeof key]>;

		const { data: parsed, error: jsonError } = trySync({
			try: () => JSON.parse(raw) as unknown,
			catch: (cause) => PersistedError.JsonParseFailed({ key, raw, cause }),
		});
		if (jsonError) {
			onError?.(key, jsonError);
			return def.defaultValue as InferDefinitionValue<TDefs[typeof key]>;
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
			return def.defaultValue as InferDefinitionValue<TDefs[typeof key]>;
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
			return def.defaultValue as InferDefinitionValue<TDefs[typeof key]>;
		}

		return result.value as InferDefinitionValue<TDefs[typeof key]>;
	}

	function readKey(key: string & keyof TDefs) {
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
		get<TKey extends string & keyof TDefs>(key: TKey) {
			return map.get(key) as InferDefinitionValue<TDefs[TKey]>;
		},

		set<TKey extends string & keyof TDefs>(
			key: TKey,
			value: InferDefinitionValue<TDefs[TKey]>,
		) {
			try {
				storageApi.setItem(storageKey(key), JSON.stringify(value));
			} catch (error) {
				onUpdateError?.(key, error);
			}
			map.set(key, value);
		},

		update(
			updates: Partial<{
				[TKey in string & keyof TDefs]: InferDefinitionValue<TDefs[TKey]>;
			}>,
		) {
			for (const [key, value] of Object.entries(updates)) {
				this.set(
					key as string & keyof TDefs,
					value as InferDefinitionValue<TDefs[string & keyof TDefs]>,
				);
			}
		},

		reset() {
			for (const key of definitionKeys) {
				this.set(
					key,
					definitions[key]!.defaultValue as InferDefinitionValue<
						TDefs[typeof key]
					>,
				);
			}
		},

		getDefault<TKey extends string & keyof TDefs>(key: TKey) {
			return definitions[key]!.defaultValue as InferDefinitionValue<
				TDefs[TKey]
			>;
		},
	};
}
