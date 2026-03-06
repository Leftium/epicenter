/**
 * Reactive Svelte 5 wrapper for `@wxt-dev/storage` items.
 *
 * Bridges the async extension storage API into synchronous, reactive
 * `$state` that can be read directly in templates and `$derived` blocks.
 *
 * - Initializes with the item's `fallback`, then async-loads the persisted value.
 * - External changes (popup, background, other tabs) sync via `.watch()`.
 * - Setter is optimistic: updates `$state` immediately, persists async.
 *
 * Follows Svelte 5 convention: `.current` accessor (same as `fromStore`,
 * `MediaQuery`, `ReactiveValue`).
 *
 * @example
 * ```typescript
 * import { storage } from '@wxt-dev/storage';
 * import { createExtensionState } from './extension-state.svelte';
 *
 * const serverUrlItem = storage.defineItem<string>('local:serverUrl', {
 *   fallback: 'https://api.epicenter.so',
 * });
 *
 * export const serverUrl = createExtensionState(serverUrlItem);
 *
 * // In a component:
 * // <p>{serverUrl.current}</p>
 * // <input bind:value={serverUrl.current} />
 * ```
 */

import type { WxtStorageItem } from '@wxt-dev/storage';

/**
 * Create a reactive Svelte 5 state backed by an extension storage item.
 *
 * The returned object exposes `.current` (get/set) and `.ready` (boolean).
 * The getter is tracked by Svelte's runtime; the setter is optimistic.
 */
export function createExtensionState<T>(item: WxtStorageItem<T, Record<string, unknown>>) {
	let value = $state<T>(item.fallback);
	let ready = $state(false);

	// Async init — load persisted value, then mark ready.
	void item.getValue().then((persisted) => {
		value = persisted;
		ready = true;
	});

	// Sync external changes from other extension contexts.
	item.watch((newValue) => {
		value = newValue;
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

		/** Whether the initial async load has completed. */
		get ready(): boolean {
			return ready;
		},
	};
}
