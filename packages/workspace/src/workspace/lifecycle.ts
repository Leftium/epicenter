/**
 * Extension lifecycle types.
 *
 * Defines the `Extension<T>` type (the resolved form all extensions take)
 * and `defineExtension()` which normalizes raw factory returns into it.
 *
 * ## The Lifecycle Contract
 *
 * Extension factories are **always synchronous**. Async initialization is tracked
 * via the returned `whenReady` promise, not the factory itself. This keeps
 * construction deterministic while allowing I/O during startup.
 *
 * ```
 * Factory (sync)                   Resolved Extension<T>
 * ─────────────────────────────────────────────────────────
 * return {                    ──►  { ...exports,
 *   db,                             whenReady: Promise<void>,  // defaulted
 *   whenReady: db.init(),            dispose: () => void,       // defaulted
 *   dispose: () => db.close(),       clearData?: () => void,
 * }                                }
 *                                   via defineExtension()
 * ```
 *
 * ## Three Lifecycle Hooks
 *
 * | Hook | Purpose | Default |
 * |------|---------|---------|
 * | `whenReady` | Track async initialization (render gates, sequencing) | `Promise.resolve()` |
 * | `dispose` | Release resources on shutdown (connections, observers) | No-op `() => {}` |
 * | `clearData` | Wipe persisted data on sign-out (IndexedDB, SQLite) | `undefined` (omit if no persistence) |
 *
 * @example
 * ```typescript
 * // Extension with exports and cleanup
 * const withCleanup: ExtensionFactory = ({ ydoc }) => {
 *   const db = new Database(':memory:');
 *   return {
 *     db,
 *     dispose: () => db.close(),
 *   };
 * };
 *
 * // Extension with async initialization
 * const persistence: ExtensionFactory = ({ ydoc }) => {
 *   const provider = new IndexeddbPersistence(ydoc.guid, ydoc);
 *   return {
 *     provider,
 *     whenReady: provider.whenSynced,
 *     dispose: () => provider.destroy(),
 *   };
 * };
 * ```
 */

import type * as Y from 'yjs';

/**
 * A value that may be synchronous or wrapped in a Promise.
 */
export type MaybePromise<T> = T | Promise<T>;


// ════════════════════════════════════════════════════════════════════════════
// EXTENSION — Flat resolved type with required lifecycle hooks
// ════════════════════════════════════════════════════════════════════════════

/**
 * The resolved form of an extension—a flat object with custom exports
 * alongside required `whenReady` and `dispose` lifecycle hooks.
 *
 * Extension factories return a raw flat object with optional `whenReady` and
 * `dispose`. The framework normalizes defaults via `defineExtension()` so the
 * stored form always has both lifecycle hooks present.
 *
 * `whenReady`, `dispose`, and `clearData` are reserved property names—extension
 * authors should not use them for custom exports.
 *
 * ## Framework Guarantees
 *
 * - `dispose()` will be called even if `whenReady` rejects
 * - `dispose()` may be called while `whenReady` is still pending
 * - Multiple `dispose()` calls should be safe (idempotent)
 * - `clearData()` is called before `dispose()` during sign-out (never alone)
 *
 * @typeParam T - Custom exports (everything except `whenReady`, `dispose`, `clearData`).
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
	/**
	 * Resolves when initialization is complete. Always present (defaults to resolved).
	 *
	 * Use this as a render gate in UI frameworks or to sequence extensions
	 * that depend on prior initialization (e.g., sync waits for persistence).
	 *
	 * Common initialization scenarios:
	 * - **Persistence**: Initial data loaded from IndexedDB or filesystem
	 * - **Sync**: First server round-trip complete, doc state merged
	 * - **SQLite**: Database opened, tables created, initial sync from Y.Doc done
	 *
	 * @example
	 * ```svelte
	 * {#await client.whenReady}
	 *   <Loading />
	 * {:then}
	 *   <App />
	 * {/await}
	 * ```
	 */
	whenReady: Promise<void>;
	/**
	 * Clean up resources. Always present (defaults to no-op).
	 *
	 * Called when the parent workspace or document is disposed. Should:
	 * - Stop observers and event listeners
	 * - Close database connections
	 * - Disconnect network providers (WebSocket, WebRTC)
	 * - Release file handles
	 *
	 * **Important**: This may be called while `whenReady` is still pending.
	 * Implementations should handle graceful cancellation—don't assume
	 * initialization finished.
	 *
	 * Must be idempotent—the framework may call it more than once.
	 */
	dispose: () => MaybePromise<void>;
	/**
	 * Wipe persisted data on sign-out. Only present on persistence extensions.
	 *
	 * Semantics vs `dispose()`:
	 * - `dispose()` releases resources but **keeps data** (normal cleanup)
	 * - `clearData()` **wipes data** but does not release resources
	 *
	 * The framework calls `clearData()` then `dispose()` during `teardown()`.
	 * Extensions without persistent state should omit this (leave `undefined`).
	 */
	clearData?: () => MaybePromise<void>;
};

/**
 * Normalize a raw flat extension return into the resolved `Extension<T>` form.
 *
 * Applies defaults:
 * - `whenReady` defaults to `Promise.resolve()` (instantly ready)
 * - `dispose` defaults to `() => {}` (no-op cleanup)
 * - `whenReady` is coerced to `Promise<void>` via `.then(() => {})`
 *
 * Called by the framework inside `withExtension()` and the document extension
 * `open()` loop. Extension authors never import this — they return plain objects
 * and the framework normalizes.
 *
 * @param input - Raw extension return (custom exports + optional whenReady/dispose)
 * @returns Resolved extension with required whenReady and dispose
 *
 * @example
 * ```typescript
 * // Framework usage (inside withExtension):
 * const raw = factory(context);
 * const resolved = defineExtension(raw ?? {});
 * extensionMap[key] = resolved;
 * disposers.push(resolved.dispose);
 * whenReadyPromises.push(resolved.whenReady);
 * ```
 */
export function defineExtension<T extends Record<string, unknown>>(
	input: T & {
		whenReady?: Promise<unknown>;
		dispose?: () => MaybePromise<void>;
		clearData?: () => MaybePromise<void>;
	},
): Extension<Omit<T, 'whenReady' | 'dispose' | 'clearData'>> {
	return {
		...input,
		whenReady: input.whenReady?.then(() => {}) ?? Promise.resolve(),
		dispose: input.dispose ?? (() => {}),
		clearData: input.clearData,
	} as Extension<Omit<T, 'whenReady' | 'dispose' | 'clearData'>>;
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
 * Does NOT include `dispose` or `[Symbol.asyncDispose]` — factories return
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
