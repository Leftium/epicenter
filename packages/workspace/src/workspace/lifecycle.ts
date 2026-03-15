/**
 * Extension lifecycle types.
 *
 * Defines the `Extension<T>` type (the resolved form all extensions take)
 * and `defineExtension()` which normalizes raw factory returns into it.
 *
 * Factory functions are **always synchronous**. Async initialization is tracked
 * via the returned `whenReady` promise, not the factory itself.
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
 * The resolved form of an extension — a flat object with custom exports
 * alongside required `whenReady` and `dispose` lifecycle hooks.
 *
 * Extension factories return a raw flat object with optional `whenReady` and
 * `dispose`. The framework normalizes defaults via `defineExtension()` so the
 * stored form always has both lifecycle hooks present.
 *
 * `whenReady` and `dispose` are reserved property names — extension authors
 * should not use them for custom exports.
 *
 * @typeParam T - Custom exports (everything except `whenReady` and `dispose`).
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
	dispose: () => MaybePromise<void>;
	/** Wipe persisted data. Only present on persistence extensions. */
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
