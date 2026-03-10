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
 * │  return Lifecycle & T    │    │  return flat { T, whenReady?, │
 * │  directly                │    │    destroy? }                  │
 * └──────────────────────────┘    └──────────────────────────────┘
 * ```
 *
 * ## Usage
 *
 * Factory functions are **always synchronous**. Async initialization is tracked
 * via the returned `whenReady` promise, not the factory itself.
 *
 * **Extensions** return a flat object with custom exports + optional lifecycle hooks:
 *
 * ```typescript
 * // Extension with exports and cleanup
 * const withCleanup: ExtensionFactory = ({ ydoc }) => {
 *   const db = new Database(':memory:');
 *   return {
 *     db,
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
// EXTENSION — Flat resolved type with required lifecycle hooks
// ════════════════════════════════════════════════════════════════════════════

/**
 * The resolved form of an extension — a flat object with custom exports
 * alongside required `whenReady` and `destroy` lifecycle hooks.
 *
 * Extension factories return a raw flat object with optional `whenReady` and
 * `destroy`. The framework normalizes defaults via `defineExtension()` so the
 * stored form always has both lifecycle hooks present.
 *
 * `whenReady` and `destroy` are reserved property names — extension authors
 * should not use them for custom exports.
 *
 * @typeParam T - Custom exports (everything except `whenReady` and `destroy`).
 *   Defaults to `Record<string, never>` for lifecycle-only extensions.
 *
 * @example
 * ```typescript
 * // What the consumer sees:
 * client.extensions.sqlite.db.query('...');
 * await client.extensions.sqlite.whenReady;
 * // typeof client.extensions.sqlite = Extension<{ db: Database; pullToSqlite: ...; }>
 *
 * // Lifecycle-only extension:
 * await client.extensions.persistence.whenReady;
 * // typeof client.extensions.persistence = Extension<Record<string, never>>
 * ```
 */
export type Extension<
	T extends Record<string, unknown> = Record<string, never>,
> = T & {
	/** Resolves when initialization is complete. Always present (defaults to resolved). */
	whenReady: Promise<void>;
	/** Clean up resources. Always present (defaults to no-op). */
	destroy: () => MaybePromise<void>;
};

/**
 * Normalize a raw flat extension return into the resolved `Extension<T>` form.
 *
 * Applies defaults:
 * - `whenReady` defaults to `Promise.resolve()` (instantly ready)
 * - `destroy` defaults to `() => {}` (no-op cleanup)
 * - `whenReady` is coerced to `Promise<void>` via `.then(() => {})`
 *
 * Called by the framework inside `withExtension()` and the document extension
 * `open()` loop. Extension authors never import this — they return plain objects
 * and the framework normalizes.
 *
 * @param input - Raw extension return (custom exports + optional whenReady/destroy)
 * @returns Resolved extension with required whenReady and destroy
 *
 * @example
 * ```typescript
 * // Framework usage (inside withExtension):
 * const raw = factory(context);
 * const resolved = defineExtension(raw ?? {});
 * extensionMap[key] = resolved;
 * destroys.push(resolved.destroy);
 * whenReadyPromises.push(resolved.whenReady);
 * ```
 */
export function defineExtension<T extends Record<string, unknown>>(
	input: T & {
		whenReady?: Promise<unknown>;
		destroy?: () => MaybePromise<void>;
	},
): Extension<Omit<T, 'whenReady' | 'destroy'>> {
	return {
		...input,
		whenReady: input.whenReady?.then(() => {}) ?? Promise.resolve(),
		destroy: input.destroy ?? (() => {}),
	} as Extension<Omit<T, 'whenReady' | 'destroy'>>;
}

// ════════════════════════════════════════════════════════════════════════════
// DOCUMENT CONTEXT — Passed to document extension factories
// ════════════════════════════════════════════════════════════════════════════

/**
 * Context passed to document extension factories registered via `withDocumentExtension()`.
 *
 * Minimal context: the content Y.Doc, workspace ID, and chain state
 * (composite whenReady + prior extensions). Intentionally lean — fields
 * like `tableName` and `tags` are omitted until a real consumer needs them.
 *
 * ```typescript
 * .withDocumentExtension('persistence', ({ ydoc }) => { ... })
 * .withDocumentExtension('sync', ({ id, ydoc, whenReady }) => { ... })
 * ```
 *
 * Extensions are optional because tag-filtered extensions may be skipped for certain
 * document types. Factories should guard access with optional chaining.
 *
 * Does NOT include `destroy` or `[Symbol.asyncDispose]` — factories return
 * their own lifecycle hooks, they don't control the document's.
 *
 * @typeParam TDocExtensions - Accumulated document extension exports from prior
 *   `.withDocumentExtension()` calls. Defaults to `Record<string, unknown>` so
 *   `DocumentExtensionRegistration` can store factories with the wide type.
 *
 * @example
 * ```typescript
 * .withDocumentExtension('sync', ({ id, ydoc, whenReady, extensions }) => {
 *   const path = `${id}/${ydoc.guid}.yjs`;
 *
 *   // Access prior document extension exports + lifecycle directly
 *   await extensions.persistence?.whenReady;
 *   extensions.persistence?.clearData();
 *
 *   // Composite: await ALL prior doc extensions
 *   await whenReady;
 * })
 * ```
 */
export type DocumentContext<
	TDocExtensions extends Record<string, unknown> = Record<string, unknown>,
> = {
	/** The workspace identifier. Matches ExtensionContext.id. */
	id: string;
	/** The content Y.Doc being created. */
	ydoc: Y.Doc;
	/** Composite whenReady of all PRIOR document extensions' results. */
	whenReady: Promise<void>;
	/**
	 * Typed access to prior document extensions (resolved form with lifecycle hooks).
	 *
	 * Each entry is optional because tag-filtered extensions may be skipped.
	 * Factories should guard access with optional chaining.
	 *
	 * @example
	 * ```typescript
	 * await extensions.persistence?.whenReady;
	 * extensions.persistence?.clearData();
	 * ```
	 */
	extensions: {
		[K in keyof TDocExtensions]?: Extension<
			TDocExtensions[K] extends Record<string, unknown>
				? TDocExtensions[K]
				: Record<string, never>
		>;
	};
};
