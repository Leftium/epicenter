/**
 * Lifecycle primitives for workspace and document extensions.
 *
 * This module defines:
 *
 * - **`RawExtension<T>`** — The factory return shape: `{ exports, init?, dispose?, clearLocalData? }`
 * - **`defineExtension()`** — Normalizes raw factory returns, separating the
 *   public exports from framework lifecycle metadata (`init`, `dispose`, `clearLocalData`)
 * - **`disposeLifo()` / `startDisposeLifo()`** — LIFO teardown for ordered cleanup
 *
 * Extension factories are **always synchronous**. Async initialization is tracked
 * via a framework-internal `init` promise (consumed to build the workspace
 * composite `whenReady`), separate from any semantic readiness fields the
 * extension may expose publicly (`whenLoaded`, `whenConnected`, etc).
 *
 * ## Factory return shape
 *
 * Extension factories return a two-layer object — public exports under
 * `exports`, framework lifecycle metadata (`init`, `dispose`, `clearLocalData`)
 * at the top level:
 *
 * ```typescript
 * const persistence: ExtensionFactory = ({ ydoc }) => {
 *   const provider = new IndexeddbPersistence(ydoc.guid, ydoc);
 *   return {
 *     exports: { whenLoaded: provider.whenSynced },   // public: "local data is loaded"
 *     init: provider.whenSynced,                       // framework: chain signal
 *     dispose: () => provider.destroy(),
 *   };
 * };
 *
 * // Lifecycle-only extension (no public exports)
 * const broadcast = ({ ydoc }) => {
 *   const channel = new BroadcastChannel(ydoc.guid);
 *   return { exports: {}, dispose: () => channel.close() };
 * };
 * ```
 *
 * The framework spreads `exports` onto `client.extensions[key]`. Lifecycle
 * metadata stays framework-internal — consumers never reach for
 * `client.extensions[key].dispose`.
 */

/**
 * A value that may be synchronous or wrapped in a Promise.
 */
export type MaybePromise<T> = T | Promise<T>;

// ════════════════════════════════════════════════════════════════════════════
// EXTENSION — Factory return shape
// ════════════════════════════════════════════════════════════════════════════

/**
 * Raw factory return shape — `exports` holds the public surface; `init`,
 * `dispose`, and `clearLocalData` are framework lifecycle metadata.
 *
 * ## Framework Guarantees
 *
 * - `dispose()` will be called even if `init` rejects
 * - `dispose()` may be called while `init` is still pending
 * - Multiple `dispose()` calls should be safe (idempotent)
 * - `clearLocalData()` is called before `dispose()` during sign-out (never alone)
 *
 * @typeParam T - Public exports object type.
 *   Defaults to `Record<string, never>` for lifecycle-only extensions.
 */
export type RawExtension<
	T extends Record<string, unknown> = Record<string, never>,
> = {
	exports: T;
	init?: Promise<unknown>;
	dispose?: () => MaybePromise<void>;
	clearLocalData?: () => MaybePromise<void>;
};

/**
 * Normalize a raw extension return, separating the public exports from
 * framework lifecycle metadata.
 *
 * Applies defaults:
 * - `init` defaults to `Promise.resolve()` (instantly ready) and is coerced to
 *   `Promise<void>` via `.then(() => {})`
 * - `dispose` defaults to `() => {}` (no-op cleanup)
 *
 * Called by the framework inside `withExtension()` and the document extension
 * `open()` loop. Extension authors never import this — they return plain
 * `{ exports, ... }` objects and the framework normalizes.
 *
 * @example
 * ```typescript
 * // Framework usage:
 * const raw = factory(context);
 * const { exports, init, dispose, clearLocalData } = defineExtension(raw);
 * extensionMap[key] = exports;
 * disposers.push(dispose);
 * initPromises.push(init);
 * ```
 */
export function defineExtension<T extends Record<string, unknown>>(
	input: RawExtension<T>,
): {
	exports: T;
	init: Promise<void>;
	dispose: () => MaybePromise<void>;
	clearLocalData?: () => MaybePromise<void>;
} {
	return {
		exports: input.exports,
		init: input.init?.then(() => {}) ?? Promise.resolve(),
		dispose: input.dispose ?? (() => {}),
		clearLocalData: input.clearLocalData,
	};
}

// ════════════════════════════════════════════════════════════════════════════
// LIFO CLEANUP — Shared teardown primitives for extensions and documents
// ════════════════════════════════════════════════════════════════════════════

/**
 * Run cleanups in LIFO order (last registered = first destroyed).
 * Continues on error and returns accumulated errors.
 *
 * Used by both `createWorkspace()` and `createDocuments()` to tear down
 * extensions in reverse creation order. Call sites handle the returned
 * errors array in their own way (throw, log, or rethrow).
 *
 *
 * @param cleanups - Array of cleanup functions to run in reverse order
 * @returns Array of errors caught during cleanup (empty if all succeeded)
 */
export async function disposeLifo(
	cleanups: (() => MaybePromise<void>)[],
): Promise<unknown[]> {
	const errors: unknown[] = [];
	for (let i = cleanups.length - 1; i >= 0; i--) {
		try {
			await cleanups[i]?.();
		} catch (err) {
			errors.push(err);
		}
	}
	return errors;
}

/**
 * Start all cleanups immediately in LIFO order without awaiting between them.
 *
 * Used in the sync builder error path where we can't await. Every cleanup is
 * invoked before the throw propagates—async portions settle in the background.
 * Rejections are observed (logged) so they don't become unhandled.
 *
 * @param cleanups - Array of cleanup functions to invoke in reverse order
 */
export function startDisposeLifo(cleanups: (() => MaybePromise<void>)[]): void {
	for (let i = cleanups.length - 1; i >= 0; i--) {
		try {
			Promise.resolve(cleanups[i]?.()).catch((err) => {
				console.error('Extension cleanup error during rollback:', err);
			});
		} catch (err) {
			console.error('Extension cleanup error during rollback:', err);
		}
	}
}
