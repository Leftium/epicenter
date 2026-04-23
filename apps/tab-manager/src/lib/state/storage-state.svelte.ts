/**
 * Reactive Svelte 5 wrapper for extension storage with schema validation.
 *
 * Bridges the async chrome.storage API into synchronous, reactive `$state`
 * that can be read directly in templates and `$derived` blocks. Values are
 * validated against a Standard Schema on every read from storage — invalid
 * data silently falls back to the default.
 *
 * Two read channels: `.current` for reactive template bindings (may be the
 * fallback before chrome.storage loads) and `.get()` for authoritative async
 * reads that wait for the real value.
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
 * // Reactive read (may be fallback before load):
 * // <p>{serverUrl.current}</p>
 * // <input bind:value={serverUrl.current} />
 * //
 * // Authoritative read (waits for chrome.storage):
 * // const url = await serverUrl.get();
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
		/**
		 * Reactive value for Svelte template bindings.
		 *
		 * Starts as `fallback` before chrome.storage loads.
		 * Use `.get()` for imperative reads that need the real value.
		 */
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
		 * Authoritative read — waits for chrome.storage to load, then returns the real value.
		 *
		 * Unlike `.current` (which returns the fallback before chrome.storage loads),
		 * `.get()` guarantees the returned value is from storage. Use this in imperative
		 * code (boot scripts, closures, event handlers) — `.current` is for templates.
		 *
		 * @example
		 * ```typescript
		 * const cached = await session.get();
		 * if (cached) {
		 *   console.log('Cached session:', cached.token);
		 * }
		 * ```
		 */
		async get(): Promise<T> {
			await whenReady;
			return value;
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
		 * Prefer `.get()` for one-off reads. `whenReady` is useful when composing
		 * multiple stores' readiness (e.g. `Promise.all([a.whenReady, b.whenReady])`).
		 */
		whenReady,

		/**
		 * Watch for external changes from other extension contexts.
		 *
		 * Only fires when chrome.storage is mutated externally (e.g. sign-out
		 * in a popup reflects in the sidebar). Writes from this context are
		 * suppressed — use reactive `$effect` or `$derived` over `.current`
		 * when you need to react to local changes.
		 *
		 * @returns Unsubscribe function
		 */
		watch(callback: (value: T) => void): () => void {
			externalWatchers.add(callback);
			return () => {
				externalWatchers.delete(callback);
			};
		},
	};
}

// ── SessionStore adapter ─────────────────────────────────────────────────────

import type { AuthSession, SessionStore } from '@epicenter/auth';

/**
 * Shape of a `createStorageState` return value narrowed to what the
 * SessionStore adapter needs. `.current` is authoritative after
 * `whenReady` resolves.
 */
type StorageSessionState = {
	current: AuthSession | null;
	whenReady: Promise<void>;
	watch(fn: (value: AuthSession | null) => void): () => void;
};

/**
 * Adapt a `createStorageState` store to the `SessionStore` contract used by
 * `@epicenter/auth`.
 *
 * Two things bridge the gap from chrome.storage to sync SessionStore:
 *
 * 1. **Hydration.** chrome.storage is async. The adapter re-exports
 *    `whenReady` so the caller can await it before constructing `createAuth`;
 *    after that, `.current` is authoritative.
 * 2. **Local-write fan-out.** The underlying `watch` only fires on external
 *    changes (from other extension contexts). SessionStore's contract
 *    requires watchers to fire on every change — including writes made via
 *    `set()`. The adapter keeps its own watcher set and notifies them
 *    directly from `set()`, in addition to forwarding external changes.
 */
export function fromStorageState(
	state: StorageSessionState,
): SessionStore & { whenReady: Promise<void> } {
	const watchers = new Set<(value: AuthSession | null) => void>();

	state.watch((next) => {
		for (const fn of watchers) fn(next);
	});

	return {
		whenReady: state.whenReady,
		get: () => state.current,
		set: (value) => {
			state.current = value;
			for (const fn of watchers) fn(value);
		},
		watch(fn) {
			watchers.add(fn);
			return () => {
				watchers.delete(fn);
			};
		},
	};
}
