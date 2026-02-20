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
 * │  directly                │    │  { exports?, lifecycle? }     │
 * └──────────────────────────┘    └──────────────────────────────┘
 * ```
 *
 * ## Usage
 *
 * Factory functions are **always synchronous**. Async initialization is tracked
 * via the returned `whenReady` promise, not the factory itself.
 *
 * **Extensions** return `{ exports?, lifecycle? }`:
 *
 * ```typescript
 * // Extension with cleanup — lifecycle wraps whenReady/destroy
 * const withCleanup: ExtensionFactory = ({ ydoc }) => {
 *   const db = new Database(':memory:');
 *   return {
 *     exports: { db },
 *     lifecycle: {
 *       destroy: () => db.close(),
 *     },
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

import type * as Y from 'yjs';

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
 * What extension factories return — an object with optional exports and lifecycle hooks.
 *
 * The framework normalizes defaults internally:
 * - `exports` defaults to `{}` (empty — lifecycle-only extensions)
 * - `lifecycle.whenReady` defaults to `Promise.resolve()` (instantly ready)
 * - `lifecycle.destroy` defaults to `() => {}` (no-op cleanup)
 *
 * Document-level extensions are registered separately via `withDocumentExtension()`.
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
 *   lifecycle: {
 *     whenReady: initPromise,
 *     destroy: () => db.close(),
 *   },
 * }))
 *
 * // Lifecycle-only (no exports)
 * .withExtension('persistence', (ctx) => ({
 *   lifecycle: {
 *     whenReady: loadFromDisk(),
 *     destroy: () => flush(),
 *   },
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
	/** Lifecycle hooks for initialization and cleanup. */
	lifecycle?: {
		/** Resolves when initialization is complete. Defaults to `Promise.resolve()`. */
		whenReady?: Promise<unknown>;
		/** Clean up resources. Defaults to no-op. */
		destroy?: () => MaybePromise<void>;
	};
};

// ════════════════════════════════════════════════════════════════════════════
// DOCUMENT LIFECYCLE TYPES — Used by document bindings and withDocumentExtension
// ════════════════════════════════════════════════════════════════════════════

/**
 * Extended lifecycle for document providers.
 *
 * Adds an optional `clearData` method for permanent deletion of persisted data.
 * This is intentionally NOT on the base `Lifecycle` type — it's a destructive
 * capability that only makes sense for per-document persistence.
 *
 * @example
 * ```typescript
 * const lifecycle: DocumentLifecycle = {
 *   whenReady: idb.whenSynced,
 *   destroy: () => idb.destroy(),
 *   clearData: () => idb.clearData(), // permanent deletion
 * };
 * ```
 */
export type DocumentLifecycle = {
	/** Resolves when initialization is complete. */
	whenReady?: Promise<unknown>;
	/** Clean up resources (free memory, disconnect). */
	destroy: () => MaybePromise<void>;
	/**
	 * Optional: delete all persisted data for this document.
	 * Called by `purge()`. Providers without persistent storage can omit this.
	 */
	clearData?: () => MaybePromise<void>;
};

/**
 * Context passed to document extension factories registered via `withDocumentExtension()`.
 *
 * Provides the content Y.Doc being created, a composite `whenReady` from
 * prior document extensions, and metadata about which table/binding this doc belongs to.
 *
 * @example
 * ```typescript
 * .withDocumentExtension('persistence', ({ ydoc, whenReady, binding }) => {
 *   const idb = new IndexeddbPersistence(ydoc.guid, ydoc);
 *   return {
 *     whenReady: idb.whenSynced,
 *     destroy: () => idb.destroy(),
 *     clearData: () => idb.clearData(),
 *   };
 * })
 * ```
 */
export type DocumentContext = {
	/** The content Y.Doc being created. */
	ydoc: Y.Doc;
	/**
	 * Composite whenReady of all PRIOR document extensions' results.
	 * Named `whenReady` for consistency with `client.whenReady`.
	 */
	whenReady: Promise<void>;
	/**
	 * Which table + binding this doc belongs to.
	 * Enables per-binding behavior (e.g., skip sync for cover images).
	 */
	binding: {
		tableName: string;
		documentName: string;
		/** The document's tags (from withDocument config). Empty if no tags declared. */
		tags: readonly string[];
	};
};
