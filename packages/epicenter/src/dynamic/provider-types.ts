import type * as Y from 'yjs';
import type { Lifecycle } from '../shared/lifecycle';

// Re-export lifecycle utilities for provider authors
export type { Lifecycle } from '../shared/lifecycle';

// ─────────────────────────────────────────────────────────────────────────────
// Doc-Level Provider Types
// ─────────────────────────────────────────────────────────────────────────────
//
// These types are for TRUE YJS providers that handle sync/persistence at the
// doc level (Head Doc, Registry Doc). They receive minimal context (just ydoc).
//
// For workspace-level extensions (SQLite, Markdown, etc.), see extension.ts.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Context provided to doc-level provider factories.
 *
 * Providers are doc-level (attached to Y.Doc), unlike extensions which are
 * workspace-level (attached to workspace with tables, kv, etc.).
 *
 * Only the Y.Doc is provided; the doc ID is accessible via `ydoc.guid`.
 */
export type ProviderContext = {
	/** The underlying Y.Doc instance. */
	ydoc: Y.Doc;
};

/**
 * The return type of a `ProviderFactory` — accessible via `doc.providers.{name}`.
 *
 * Combines the lifecycle protocol with custom exports.
 * The framework guarantees `whenReady` and `destroy` exist on all providers.
 *
 * @typeParam T - Additional exports beyond lifecycle fields
 *
 * @example
 * ```typescript
 * // Type for a provider that exports a connection
 * type SyncProvider = Provider<{ connection: WebSocket }>;
 * // → { whenReady, destroy, connection }
 *
 * // Type for a provider with no custom exports
 * type SimpleProvider = Provider;
 * // → { whenReady, destroy }
 * ```
 */
export type Provider<T extends Record<string, unknown> = {}> = Lifecycle & T;

/**
 * A doc-level provider factory function.
 *
 * Factories are **always synchronous**. Async initialization is tracked via
 * the returned `whenReady` promise, not the factory itself.
 *
 * Return an object satisfying the `Lifecycle` protocol directly.
 * The framework fills in defaults for missing fields:
 * - `whenReady`: defaults to `Promise.resolve()`
 * - `destroy`: defaults to no-op `() => {}`
 *
 * @example Persistence provider
 * ```typescript
 * const persistence: ProviderFactory = ({ ydoc }) => {
 *   const provider = new IndexeddbPersistence(ydoc.guid, ydoc);
 *   return {
 *     whenReady: provider.whenReady,
 *     destroy: () => provider.destroy(),
 *   };
 * };
 * ```
 *
 * @example Sync provider with WebSocket
 * ```typescript
 * const sync: ProviderFactory = ({ ydoc }) => {
 *   const provider = createSyncProvider({ doc: ydoc, url });
 *   return {
 *     provider,
 *     whenReady: Promise.resolve(),
 *     destroy: () => provider.destroy(),
 *   };
 * };
 * ```
 */
export type ProviderFactory<TExports extends Provider = Provider> = (
	context: ProviderContext,
) => TExports;

/**
 * Map of provider factories keyed by provider ID.
 */
export type ProviderFactoryMap = Record<string, ProviderFactory>;

/**
 * Infer the return type of provider factories.
 */
export type InferProviderReturn<T extends ProviderFactoryMap> = {
	[K in keyof T]: ReturnType<T[K]>;
};
