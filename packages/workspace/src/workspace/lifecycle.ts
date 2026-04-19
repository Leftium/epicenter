/**
 * Lifecycle primitives for workspace and document extensions.
 *
 * This module defines:
 *
 * - **`Extension<T>`** — Resolved form: custom exports + required `dispose`
 * - **`defineExtension()`** — Normalizes raw factory returns, separating the
 *   framework-internal chain signal (`init`) from public exports
 * - **`disposeLifo()` / `startDisposeLifo()`** — LIFO teardown for ordered cleanup
 *
 * Extension factories are **always synchronous**. Async initialization is tracked
 * via a framework-internal `init` promise (consumed to build the workspace
 * composite `whenReady`), separate from any semantic readiness fields the
 * extension may expose publicly (`whenLoaded`, `whenConnected`, etc).
 *
 * ## Two Lifecycle Hooks + one framework-internal chain signal
 *
 * | Hook | Purpose | Default |
 * |------|---------|---------|
 * | `init` | Framework chain input: workspace composite `whenReady` waits on every extension's `init` | `Promise.resolve()` |
 * | `dispose` | Release resources on shutdown (connections, observers) | No-op `() => {}` |
 * | `clearLocalData` | Wipe persisted data on sign-out (IndexedDB, SQLite) | `undefined` (omit if no persistence) |
 *
 * `init` is framework-internal — extensions author it but callers never reach
 * for `extension.init`. Anything an extension wants to expose publicly uses a
 * semantic field name (`whenLoaded`, `whenConnected`, …).
 *
 * ```typescript
 * // Extension with semantic readiness + framework chain signal
 * const persistence: ExtensionFactory = ({ ydoc }) => {
 *   const provider = new IndexeddbPersistence(ydoc.guid, ydoc);
 *   return {
 *     whenLoaded: provider.whenSynced,    // public: "local data is loaded"
 *     init: provider.whenSynced,          // framework: chain signal
 *     dispose: () => provider.destroy(),
 *   };
 * };
 *
 * // Lifecycle-only extension (no custom exports)
 * const broadcast = ({ ydoc }) => {
 *   const channel = new BroadcastChannel(ydoc.guid);
 *   return { dispose: () => channel.close() };
 * };
 * ```
 */

/**
 * A value that may be synchronous or wrapped in a Promise.
 */
export type MaybePromise<T> = T | Promise<T>;

// ════════════════════════════════════════════════════════════════════════════
// EXTENSION — Flat resolved type with required lifecycle hooks
// ════════════════════════════════════════════════════════════════════════════

/**
 * The resolved form of an extension — a flat object with custom exports
 * alongside a required `dispose` hook and optional `clearLocalData`.
 *
 * Extension factories return a raw flat object with optional `init`,
 * `dispose`, and `clearLocalData`. The framework normalizes defaults via
 * `defineExtension()` and strips `init` off the resolved form — `init` is a
 * framework-internal chain signal, not a public export.
 *
 * `init`, `dispose`, and `clearLocalData` are reserved property names —
 * extension authors should not use them for custom exports.
 *
 * ## Framework Guarantees
 *
 * - `dispose()` will be called even if `init` rejects
 * - `dispose()` may be called while `init` is still pending
 * - Multiple `dispose()` calls should be safe (idempotent)
 * - `clearLocalData()` is called before `dispose()` during sign-out (never alone)
 *
 * @typeParam T - Custom exports (everything except `init`, `dispose`, `clearLocalData`).
 *   Defaults to `Record<string, never>` for lifecycle-only extensions.
 *
 * @example
 * ```typescript
 * // What the consumer sees — only semantic fields + dispose:
 * client.extensions.persistence.whenLoaded;   // extension's public API
 * client.extensions.sqlite.db.query('...');
 *
 * // The composite readiness lives at the workspace level:
 * await client.whenReady;
 * ```
 */
export type Extension<
	T extends Record<string, unknown> = Record<string, never>,
> = T & {
	/**
	 * Clean up resources. Always present (defaults to no-op).
	 *
	 * Called when the parent workspace or document is disposed. Should:
	 * - Stop observers and event listeners
	 * - Close database connections
	 * - Disconnect network providers (WebSocket, WebRTC)
	 * - Release file handles
	 *
	 * **Important**: This may be called while the extension's `init` is still
	 * pending. Implementations should handle graceful cancellation — don't
	 * assume initialization finished.
	 *
	 * Must be idempotent — the framework may call it more than once.
	 */
	dispose: () => MaybePromise<void>;
	/**
	 * Wipe persisted data on sign-out. Only present on persistence extensions.
	 *
	 * Semantics vs `dispose()`:
	 * - `dispose()` releases resources but **keeps data** (normal cleanup)
	 * - `clearLocalData()` **wipes data** but does not release resources
	 *
	 * The framework calls `clearLocalData()` during `workspace.clearLocalData()`
	 * in LIFO order.
	 * Extensions without persistent state should omit this (leave `undefined`).
	 */
	clearLocalData?: () => MaybePromise<void>;
};

/**
 * Normalize a raw flat extension return, separating the framework-internal
 * `init` chain signal from the extension's public exports.
 *
 * Applies defaults:
 * - `init` defaults to `Promise.resolve()` (instantly ready) and is coerced to
 *   `Promise<void>` via `.then(() => {})`
 * - `dispose` defaults to `() => {}` (no-op cleanup)
 *
 * The returned shape splits the two concerns: the composite workspace-level
 * `whenReady` chains on the extracted `init`; consumers see `extension` (custom
 * exports + `dispose` + optional `clearLocalData`).
 *
 * Called by the framework inside `withExtension()` and the document extension
 * `open()` loop. Extension authors never import this — they return plain objects
 * and the framework normalizes.
 *
 * @example
 * ```typescript
 * // Framework usage (inside withExtension):
 * const raw = factory(context);
 * const { extension, init } = defineExtension(raw ?? {});
 * extensionMap[key] = extension;
 * disposers.push(extension.dispose);
 * initPromises.push(init);
 * ```
 */
export function defineExtension<T extends Record<string, unknown>>(
	input: T & {
		init?: Promise<unknown>;
		dispose?: () => MaybePromise<void>;
		clearLocalData?: () => MaybePromise<void>;
	},
): {
	extension: Extension<Omit<T, 'init' | 'dispose' | 'clearLocalData'>>;
	init: Promise<void>;
} {
	const { init, dispose, clearLocalData, ...exports } = input as T & {
		init?: Promise<unknown>;
		dispose?: () => MaybePromise<void>;
		clearLocalData?: () => MaybePromise<void>;
	};
	return {
		extension: {
			...(exports as unknown as Omit<T, 'init' | 'dispose' | 'clearLocalData'>),
			dispose: dispose ?? (() => {}),
			clearLocalData,
		} as Extension<Omit<T, 'init' | 'dispose' | 'clearLocalData'>>,
		init: init?.then(() => {}) ?? Promise.resolve(),
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
