/**
 * Lifecycle protocol for providers and extensions.
 *
 * This module defines the shared lifecycle contract that all providers (doc-level)
 * and extensions (workspace-level) must satisfy. The protocol enables:
 *
 * - **Async initialization tracking**: `whenReady` lets UI render gates wait for readiness
 * - **Resource cleanup**: `destroy` ensures connections, observers, and handles are released
 *
 * ## Architecture
 *
 * ```
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  Lifecycle (base protocol)                                      │
 * │    { whenReady, destroy }                                       │
 * └─────────────────────────────────────────────────────────────────┘
 *          │                                    │
 *          ▼                                    ▼
 * ┌──────────────────────────┐    ┌──────────────────────────────┐
 * │  Providers (doc-level)   │    │  Extensions (workspace-level) │
 * │  return Lifecycle & T    │    │  return Extension<T>          │
 * │  directly                │    │  { exports?, whenReady?,      │
 * └──────────────────────────┘    │    destroy? }                 │
 *                                 └──────────────────────────────┘
 * ```
 *
 * ## Usage
 *
 * Factory functions are **always synchronous**. Async initialization is tracked
 * via the returned `whenReady` promise, not the factory itself.
 *
 * **Extensions** return a flat `{ exports?, whenReady?, destroy? }` object:
 *
 * ```typescript
 * // Extension with cleanup — flat return, framework normalizes defaults
 * const withCleanup: ExtensionFactory = ({ ydoc }) => {
 *   const db = new Database(':memory:');
 *   return {
 *     exports: { db },
 *     destroy: () => db.close(),
 *   };
 * };
 * ```
 *
 * **Providers** return `Lifecycle` (or `Lifecycle & T`) directly:
 *
 * ```typescript
 * // Provider with async initialization
 * const persistence: ProviderFactory = ({ ydoc }) => {
 *   const provider = new IndexeddbPersistence(ydoc.guid, ydoc);
 *   return {
 *     whenReady: provider.whenReady,
 *     destroy: () => provider.destroy(),
 *   };
 * };
 * ```
 */

/**
 * A value that may be synchronous or wrapped in a Promise.
 */
export type MaybePromise<T> = T | Promise<T>;

/**
 * The lifecycle protocol for providers and extensions.
 *
 * This is the base contract that all providers and extensions satisfy.
 * It defines two required lifecycle methods:
 *
 * - `whenReady`: A promise that resolves when initialization is complete
 * - `destroy`: A cleanup function called when the parent is destroyed
 *
 * ## When to use each field
 *
 * | Field | Purpose | Example |
 * |-------|---------|---------|
 * | `whenReady` | Track async initialization | Database indexing, initial sync |
 * | `destroy` | Clean up resources | Close connections, unsubscribe observers |
 *
 * ## Framework guarantees
 *
 * - `destroy()` will be called even if `whenReady` rejects
 * - `destroy()` may be called while `whenReady` is still pending
 * - Multiple `destroy()` calls should be safe (idempotent)
 *
 * @example
 * ```typescript
 * // Lifecycle with async init and cleanup
 * const lifecycle: Lifecycle = {
 *   whenReady: database.initialize(),
 *   destroy: () => database.close(),
 * };
 *
 * // Lifecycle with no async init
 * const simpleLifecycle: Lifecycle = {
 *   whenReady: Promise.resolve(),
 *   destroy: () => observer.unsubscribe(),
 * };
 * ```
 */
export type Lifecycle = {
	/**
	 * Resolves when initialization is complete.
	 *
	 * Use this as a render gate in UI frameworks:
	 *
	 * ```svelte
	 * {#await client.whenReady}
	 *   <Loading />
	 * {:then}
	 *   <App />
	 * {/await}
	 * ```
	 *
	 * Common initialization scenarios:
	 * - Persistence providers: Initial data loaded from storage
	 * - Sync providers: Initial server sync complete
	 * - SQLite: Database ready and indexed
	 */
	whenReady: Promise<unknown>;

	/**
	 * Clean up resources.
	 *
	 * Called when the parent doc/client is destroyed. Should:
	 * - Stop observers and event listeners
	 * - Close database connections
	 * - Disconnect network providers
	 * - Release file handles
	 *
	 * **Important**: This may be called while `whenReady` is still pending.
	 * Implementations should handle graceful cancellation.
	 */
	destroy: () => MaybePromise<void>;
};

// ════════════════════════════════════════════════════════════════════════════
// EXTENSION RESULT — Separated lifecycle from consumer exports
// ════════════════════════════════════════════════════════════════════════════

/**
 * What extension factories return — a flat object with optional exports and lifecycle hooks.
 *
 * The framework normalizes defaults internally:
 * - `exports` defaults to `{}` (empty — lifecycle-only extensions)
 * - `whenReady` defaults to `Promise.resolve()` (instantly ready)
 * - `destroy` defaults to `() => {}` (no-op cleanup)
 *
 * The `exports` object is stored **by reference** in `workspace.extensions[key]` —
 * getters, proxies, and object identity are preserved.
 *
 * @typeParam T - The exports object type (what consumers access via `workspace.extensions[key]`)
 *
 * @example
 * ```typescript
 * // Extension with exports + lifecycle
 * .withExtension('sqlite', (ctx) => ({
 *   exports: { db, pullToSqlite },
 *   whenReady: initPromise,
 *   destroy: () => db.close(),
 * }))
 *
 * // Lifecycle-only (no exports)
 * .withExtension('persistence', (ctx) => ({
 *   whenReady: loadFromDisk(),
 *   destroy: () => flush(),
 * }))
 *
 * // Exports-only (no lifecycle)
 * .withExtension('helpers', () => ({
 *   exports: { compute: (x: number) => x * 2 },
 * }))
 * ```
 */
export type Extension<
	T extends Record<string, unknown> = Record<string, never>,
> = {
	/** Consumer-facing exports stored by reference in `workspace.extensions[key]` */
	exports?: T;
	/** Resolves when initialization is complete. Defaults to `Promise.resolve()`. */
	whenReady?: Promise<unknown>;
	/** Clean up resources. Defaults to no-op. */
	destroy?: () => MaybePromise<void>;
};

/**
 * Define an extension's exports and lifecycle hooks as separate concerns.
 *
 * Separates lifecycle hooks from consumer exports. The `exports` object is stored
 * **by reference** — getters, proxies, and object identity are preserved.
 *
 * ## When to use
 *
 * Use in any extension factory that is passed to `withExtension()`:
 *
 * ```typescript
 * .withExtension('sqlite', ({ ydoc }) => {
 *   const db = new Database(':memory:');
 *   return defineExtension({
 *     exports: { db, query: (sql) => db.exec(sql) },
 *     destroy: () => db.close(),
 *   });
 * })
 * ```
 *
 * ## Defaults
 *
 * | Field | Default when omitted |
 * |-------|---------------------|
 * | `exports` | `{}` (empty object — valid for lifecycle-only extensions) |
 * | `whenReady` | `Promise.resolve()` (instantly ready) |
 * | `destroy` | `() => {}` (no-op cleanup) |
 *
 * @param options - Optional configuration with exports and/or lifecycle hooks
 * @returns `Extension<T>` with exports stored by reference and lifecycle normalized
 *
 * @example Lifecycle-only extension (no consumer exports)
 * ```typescript
 * return defineExtension({
 *   whenReady: loadPromise,
 *   destroy: cleanup,
 * });
 * // → exports: {}, lifecycle: { whenReady: loadPromise, destroy: cleanup }
 * ```
 *
 * @example Exports-only extension (no lifecycle)
 * ```typescript
 * return defineExtension({
 *   exports: { compute: (x) => x * 2 },
 * });
 * // → exports: { compute }, lifecycle: { whenReady: resolved, destroy: noop }
 * ```
 *
 * @example Getter-based extension (preserves getters)
 * ```typescript
 * return defineExtension({
 *   exports: {
 *     get provider() { return currentProvider; },
 *     reconnect(newAuth) { ... },
 *   },
 *   whenReady,
 *   destroy() { provider.destroy(); },
 * });
 * // → exports stored by reference — getter survives
 * ```
 *
 * @example Full extension with exports + lifecycle
 * ```typescript
 * return defineExtension({
 *   exports: { db, pullToSqlite, pushFromSqlite },
 *   whenReady: db.initialize(),
 *   destroy: () => db.close(),
 * });
 * ```
 */
export function defineExtension<
	T extends Record<string, unknown> = Record<string, never>,
>(
	options?: {
		exports?: T;
		whenReady?: Promise<unknown>;
		destroy?: () => MaybePromise<void>;
	} | void | null,
): Extension<T> {
	return {
		exports: (options?.exports ?? {}) as T,
		whenReady: options?.whenReady ?? Promise.resolve(),
		destroy: options?.destroy ?? (() => {}),
	};
}
