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
 * import { createStorageState } from './storage-state.svelte';
 *
 * export const serverUrl = createStorageState('local:serverUrl', {
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
export function createStorageState<TSchema extends StandardSchemaV1>(
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

	/**
	 * Number of writes we initiated that haven't resolved yet.
	 *
	 * chrome.storage fires `onChanged` for ALL writes — including our own.
	 * Without this guard, the watch callback would echo our optimistic value
	 * back (harmless but wasteful), or worse, revert the UI to a stale value
	 * when rapid writes overlap (set "A" → set "B" → watch fires "A" → flicker).
	 *
	 * While writes are in-flight we suppress watch. Once the last write lands,
	 * we re-read storage to pick up any external changes we missed.
	 */
	let writesInFlight = 0;

	/**
	 * External change watchers — notified when chrome.storage changes
	 * from another extension context (NOT from our own writes).
	 *
	 * Inherits the same `writesInFlight` suppression as the internal
	 * `item.watch` — only genuinely external mutations fire callbacks.
	 */
	const externalWatchers = new Set<(newValue: T) => void>();

	// Async init — load persisted value from chrome.storage.
	// Exposes a promise so consumers can await readiness before reading.
	const whenReady = item.getValue().then((persisted) => {
		value = validate(persisted) ?? fallback;
	});

	// Sync external changes from other extension contexts, with validation.
	// Suppressed while we have our own writes in-flight to avoid echo/flicker.
	item.watch((newValue) => {
		if (writesInFlight > 0) return;
		value = validate(newValue) ?? fallback;
		for (const watcher of externalWatchers) watcher(value);
	});

	/** Persist a value and track the in-flight write. */
	const writeToStorage = (newValue: T): Promise<void> => {
		writesInFlight++;
		return item.setValue(newValue).finally(() => {
			writesInFlight--;
			if (writesInFlight === 0) {
				// Re-read to catch any external changes we suppressed.
				void item.getValue().then((v) => {
					value = validate(v) ?? fallback;
				});
			}
		});
	};

	return {
		/** Current reactive value. Starts as `fallback`, updates once loaded. */
		get current(): T {
			return value;
		},

		/**
		 * Optimistic set — updates the reactive `$state` immediately so Svelte
		 * bindings reflect the change on the same tick, then persists async.
		 */
		set current(newValue: T) {
			value = newValue;
			void writeToStorage(newValue);
		},

		/**
		 * Awaitable set — updates UI immediately, resolves once persisted.
		 * Useful when callers need to know the write completed.
		 */
		async set(newValue: T): Promise<void> {
			value = newValue;
			await writeToStorage(newValue);
		},

		/**
		 * Resolves once the initial value has been loaded from chrome.storage.
		 *
		 * Await this before reading `.current` in async code paths where the
		 * fallback value would cause incorrect behavior (e.g. auth token checks).
		 */
		whenReady,

		/**
		 * Watch for external changes from other extension contexts.
		 *
		 * Only fires when chrome.storage is mutated externally (e.g. sign-out
		 * in a popup reflects in the sidebar). Writes from this context are
		 * suppressed—use reactive `$effect` or `$derived` over `.current`
		 * when you need to react to local changes.
		 *
		 * The callback receives the validated value (or fallback if invalid).
		 *
		 * @returns Unsubscribe function
		 *
		 * @example
		 * ```typescript
		 * const unsub = authToken.watch((token) => {
		 *   if (!token) handleLogout();
		 * });
		 * ```
		 */
		watch(callback: (value: T) => void): () => void {
			externalWatchers.add(callback);
			return () => { externalWatchers.delete(callback); };
		},
	};
}
