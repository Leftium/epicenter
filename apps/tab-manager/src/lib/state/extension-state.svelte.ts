/**
 * Reactive Svelte 5 wrapper for extension storage with schema validation.
 *
 * Bridges the async chrome.storage API into synchronous, reactive `$state`
 * that can be read directly in templates and `$derived` blocks. Values are
 * validated against a Standard Schema on every read from storage — invalid
 * data silently falls back to the default.
 *
 * Follows Svelte 5 convention: `.current` accessor (same as `fromStore`,
 * `MediaQuery`, `ReactiveValue`).
 *
 * @example
 * ```typescript
 * import { type } from 'arktype';
 * import { createExtensionState } from './extension-state.svelte';
 *
 * export const serverUrl = createExtensionState('local:serverUrl', {
 *   fallback: 'https://api.epicenter.so',
 *   schema: type('string'),
 * });
 *
 * // In a component:
 * // <p>{serverUrl.current}</p>
 * // <input bind:value={serverUrl.current} />
 * ```
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import { type StorageItemKey, storage } from '@wxt-dev/storage';

/**
 * Create a reactive Svelte 5 state backed by extension storage.
 *
 * The type is inferred from the schema. Values read from storage are
 * validated — if they don't match the schema, the fallback is used
 * (without writing it back to storage).
 */
export function createExtensionState<TSchema extends StandardSchemaV1>(
	key: StorageItemKey,
	{
		fallback,
		schema,
	}: {
		fallback: StandardSchemaV1.InferOutput<TSchema>;
		schema: TSchema;
	},
) {
	type T = StandardSchemaV1.InferOutput<TSchema>;

	/**
	 * Validate a value against the schema synchronously.
	 * Returns the validated value on success, or `undefined` on failure.
	 */
	const validate = (raw: unknown): T | undefined => {
		const result = schema['~standard'].validate(raw);
		if (result instanceof Promise)
			throw new TypeError('Async schemas not supported');
		if (result.issues) return undefined;
		return result.value;
	};

	const item = storage.defineItem<T>(key, { fallback });

	let value = $state<T>(fallback);
	let ready = $state(false);

	// Async init — load persisted value, validate, then mark ready.
	void item.getValue().then((persisted) => {
		value = validate(persisted) ?? fallback;
		ready = true;
	});

	// Sync external changes from other extension contexts, with validation.
	item.watch((newValue) => {
		value = validate(newValue) ?? fallback;
	});

	return {
		/** Current reactive value. Starts as `fallback`, updates once loaded. */
		get current(): T {
			return value;
		},

		/** Optimistic set — updates UI immediately, persists async. */
		set current(newValue: T) {
			value = newValue;
			void item.setValue(newValue);
		},

		/** Awaitable set — updates UI immediately, resolves when persisted. */
		async set(newValue: T): Promise<void> {
			value = newValue;
			await item.setValue(newValue);
		},

		/** Whether the initial async load has completed. */
		get ready(): boolean {
			return ready;
		},
	};
}
