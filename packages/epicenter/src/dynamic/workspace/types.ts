/**
 * Type definitions for the dynamic workspace builder pattern.
 *
 * These types enable the ergonomic builder API where `createWorkspace()` returns
 * a client that IS directly usable AND has `.withExtension()` for chainable extensions.
 *
 * ## Why `.withExtension()` is chainable (not a map)
 *
 * Extensions use chainable `.withExtension(key, factory)` calls because
 * extensions build on each other progressively.
 * Each `.withExtension()` call returns a new builder where the next extension's factory
 * receives the accumulated extensions-so-far as typed context. This means extension N+1
 * can access extension N's exports. You may also be importing extensions you don't fully
 * control, and chaining lets you compose on top of them without modifying their source.
 *
 * ## Pattern Overview
 *
 * ```typescript
 * // Direct use (no extensions)
 * const workspace = createWorkspace(definition);
 * workspace.tables.get('posts').upsert({...});  // Works immediately!
 *
 * // With extensions (chained)
 * const workspace = createWorkspace(definition)
 *   .withExtension('persistence', indexeddbPersistence)
 *   .withExtension('sync', ySweetSync({ auth: directAuth('...') }));
 * workspace.extensions.persistence;  // Typed!
 * workspace.extensions.sync;         // Typed!
 * ```
 *
 * @module
 */

import type * as Y from 'yjs';
import type { Extension } from '../../shared/lifecycle';
import type { Kv } from '../kv/create-kv';
import type { KvField, TableDefinition } from '../schema/fields/types';
import type { Tables } from '../tables/create-tables';

// ════════════════════════════════════════════════════════════════════════════
// EXTENSION TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * Context passed to extension factories — the full "client-so-far".
 *
 * Each `.withExtension()` call passes the current `WorkspaceClient` to the factory.
 * The `extensions` field contains all previously added extensions, fully typed.
 * This enables progressive composition: extension N+1 can access extension N's exports.
 *
 * Includes `whenReady` (composite of all prior extensions' readiness), `destroy`,
 * and all other client fields — giving extensions full access to sequence after
 * prior extensions via `await context.whenReady`.
 *
 * @typeParam TTableDefinitions - Array of table definitions for this workspace
 * @typeParam TKvFields - Array of KV field definitions for this workspace
 * @typeParam TExtensions - Accumulated extension exports from previous `.withExtension()` calls
 *
 * @example
 * ```typescript
 * .withExtension('sync', (context) => {
 *   const provider = createProvider(context.ydoc);
 *   const whenReady = (async () => {
 *     await context.whenReady; // wait for all prior extensions (persistence, etc.)
 *     provider.connect();
 *   })();
 *   return { exports: { provider }, whenReady, destroy: () => provider.destroy() };
 * })
 * ```
 */
export type ExtensionContext<
	TTableDefinitions extends
		readonly TableDefinition[] = readonly TableDefinition[],
	TKvFields extends readonly KvField[] = readonly KvField[],
	TExtensions extends Record<string, unknown> = Record<string, unknown>,
> = WorkspaceClient<TTableDefinitions, TKvFields, TExtensions>;

/**
 * Factory function that creates an extension with lifecycle hooks.
 *
 * Returns a flat `{ exports?, whenReady?, destroy? }` object.
 * The framework normalizes defaults and stores `exports` by reference —
 * getters and object identity are preserved.
 *
 * @typeParam TExports - The consumer-facing exports object type
 *
 * @example
 * ```typescript
 * const persistence: ExtensionFactory = ({ ydoc }) => {
 *   const provider = new IndexeddbPersistence(ydoc.guid, ydoc);
 *   return {
 *     exports: { provider },
 *     whenReady: provider.whenReady,
 *     destroy: () => provider.destroy(),
 *   };
 * };
 * ```
 */
export type ExtensionFactory<
	TExports extends Record<string, unknown> = Record<string, unknown>,
> = (context: ExtensionContext) => Extension<TExports>;

// ════════════════════════════════════════════════════════════════════════════
// WORKSPACE CLIENT TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * The workspace client returned by createWorkspace().
 *
 * Contains all workspace resources plus extension exports.
 *
 * @typeParam TTableDefinitions - Table definitions for this workspace
 * @typeParam TKvFields - KV field definitions for this workspace
 * @typeParam TExtensions - Accumulated extension exports (defaults to empty)
 */
export type WorkspaceClient<
	TTableDefinitions extends readonly TableDefinition[],
	TKvFields extends readonly KvField[],
	TExtensions extends Record<string, unknown> = Record<string, never>,
> = {
	/** Workspace identifier */
	id: string;
	/** The underlying Y.Doc instance */
	ydoc: Y.Doc;
	/** Typed table helpers */
	tables: Tables<TTableDefinitions>;
	/** Typed KV helper */
	kv: Kv<TKvFields>;
	/** Extension exports (accumulated via `.withExtension()` calls) */
	extensions: TExtensions;
	/** Promise resolving when all extensions are ready */
	whenReady: Promise<void>;
	/** Cleanup all resources */
	destroy(): Promise<void>;
	/** Async dispose support for `await using` */
	[Symbol.asyncDispose](): Promise<void>;
};

/**
 * Builder returned by `createWorkspace()` and by each `.withExtension()` call.
 *
 * IS a usable client AND has `.withExtension()` for chaining.
 *
 * Extensions are chained because they build on each other progressively —
 * each factory receives the client-so-far (including previously added extensions)
 * as typed context. This enables extension N+1 to access extension N's exports.
 *
 * @typeParam TTableDefinitions - Table definitions for this workspace
 * @typeParam TKvFields - KV field definitions for this workspace
 * @typeParam TExtensions - Accumulated extension exports
 */
export type WorkspaceClientBuilder<
	TTableDefinitions extends readonly TableDefinition[],
	TKvFields extends readonly KvField[],
	TExtensions extends Record<string, unknown> = Record<string, never>,
> = WorkspaceClient<TTableDefinitions, TKvFields, TExtensions> & {
	/**
	 * Add a single extension. Returns a new builder with the extension's
	 * exports accumulated into the extensions type.
	 *
	 * The factory returns a flat `{ exports?, whenReady?, destroy? }` object.
	 * The framework normalizes defaults and stores `exports` by reference —
	 * getters and object identity are preserved.
	 *
	 * @param key - Unique name for this extension (used as the key in `.extensions`)
	 * @param factory - Factory function receiving the client-so-far context, returns Extension
	 * @returns A new builder with the extension's exports added to the type
	 *
	 * @example
	 * ```typescript
	 * const workspace = createWorkspace(definition)
	 *   .withExtension('persistence', ({ ydoc }) => {
	 *     return { whenReady: loadFromDisk(), destroy: () => flush() };
	 *   })
	 *   .withExtension('sync', ({ extensions }) => {
	 *     // extensions.persistence is fully typed here!
	 *     return { exports: { provider }, whenReady, destroy: () => provider.destroy() };
	 *   });
	 * ```
	 */
	withExtension<TKey extends string, TExports extends Record<string, unknown>>(
		key: TKey,
		factory: (
			context: ExtensionContext<TTableDefinitions, TKvFields, TExtensions>,
		) => Extension<TExports>,
	): WorkspaceClientBuilder<
		TTableDefinitions,
		TKvFields,
		TExtensions & Record<TKey, TExports>
	>;
};

// Re-export Extension for convenience
export type { Extension } from '../../shared/lifecycle';
