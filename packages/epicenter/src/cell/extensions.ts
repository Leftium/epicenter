/**
 * Cell Extension System
 *
 * Extensions add capabilities to a CellWorkspace (persistence, sync, SQLite materialization, etc.).
 * They receive typed context based on the workspace definition and must satisfy the Lifecycle protocol.
 *
 * ## Architecture
 *
 * Extensions are initialized via the builder pattern:
 *
 * ```typescript
 * const workspace = createCellWorkspace({ headDoc, definition })
 *   .withExtensions({
 *     sqlite: (ctx) => {
 *       // ctx.table('posts') is typed based on definition!
 *       const posts = ctx.table('posts');
 *       return defineExports({ db: ... });
 *     },
 *   });
 * ```
 *
 * ## Why Builder Pattern?
 *
 * 1. `createCellWorkspace({ headDoc, definition })` locks in table types from the definition
 * 2. `.withExtensions({ ... })` provides extensions with fully typed context
 * 3. Extensions receive `table(tableId)` typed based on definition's table keys
 *
 * @packageDocumentation
 */

import type * as Y from 'yjs';
import type { Lifecycle } from '../core/lifecycle';
import type { Field, TableDefinition } from '../core/schema/fields/types';
import type { WorkspaceDefinition } from '../core/workspace/workspace';
import type { KvStore, TableHelper } from './types';

/**
 * Context provided to cell extension factories.
 *
 * Extensions receive typed access to workspace resources. The `table()` method
 * is typed based on the workspace definition's table keys.
 *
 * @typeParam TTableDefs - The table definitions from the workspace schema (array format)
 */
export type CellExtensionContext<
	TTableDefs extends readonly TableDefinition<
		readonly Field[]
	>[] = readonly TableDefinition<readonly Field[]>[],
> = {
	/** The underlying Y.Doc instance */
	ydoc: Y.Doc;
	/** Workspace identifier (no epoch suffix) */
	workspaceId: string;
	/** Current epoch number */
	epoch: number;
	/** Get a table helper by ID (typed based on definition) */
	table<K extends TTableDefs[number]['id']>(tableId: K): TableHelper;
	table(tableId: string): TableHelper;
	/** KV store for workspace-level values */
	kv: KvStore;
	/** The full workspace definition */
	definition: WorkspaceDefinition;
	/** This extension's ID (the key in the extensions map) */
	extensionId: string;
};

/**
 * A cell extension factory function.
 *
 * Factories are **always synchronous**. Async initialization is tracked via
 * the returned `whenSynced` promise, not the factory itself.
 *
 * Use `defineExports()` to wrap your return for explicit type safety and
 * lifecycle normalization.
 *
 * @typeParam TTableDefs - The table definitions from the workspace schema (array format)
 * @typeParam TExports - Additional exports beyond lifecycle fields
 *
 * @example Persistence extension
 * ```typescript
 * const persistence: CellExtensionFactory = (ctx) => {
 *   const provider = new IndexeddbPersistence(ctx.ydoc.guid, ctx.ydoc);
 *   return defineExports({
 *     whenSynced: provider.whenSynced,
 *     destroy: () => provider.destroy(),
 *   });
 * };
 * ```
 *
 * @example SQLite materialization
 * ```typescript
 * const sqlite: CellExtensionFactory<MyTables, { db: Database }> = (ctx) => {
 *   const db = new Database(':memory:');
 *   // ctx.table('posts') is typed!
 *   ctx.table('posts').observe((changes) => {
 *     // Sync to SQLite...
 *   });
 *   return defineExports({
 *     db,
 *     destroy: () => db.close(),
 *   });
 * };
 * ```
 */
export type CellExtensionFactory<
	TTableDefs extends readonly TableDefinition<
		readonly Field[]
	>[] = readonly TableDefinition<readonly Field[]>[],
	TExports extends Lifecycle = Lifecycle,
> = (context: CellExtensionContext<TTableDefs>) => TExports;

/**
 * Map of extension factories keyed by extension ID.
 *
 * @typeParam TTableDefs - The table definitions from the workspace schema (array format)
 */
export type CellExtensionFactoryMap<
	TTableDefs extends readonly TableDefinition<
		readonly Field[]
	>[] = readonly TableDefinition<readonly Field[]>[],
> = Record<string, CellExtensionFactory<TTableDefs, Lifecycle>>;

/**
 * Infer extension exports from a factory map.
 *
 * This extracts the return types from each factory for use in the
 * `workspace.extensions` property.
 *
 * @typeParam T - The extension factory map
 */
export type InferCellExtensionExports<T> = {
	[K in keyof T]: T[K] extends CellExtensionFactory<
		infer _TTableDefs,
		infer TExports
	>
		? TExports
		: Lifecycle;
};

/**
 * Builder interface for adding extensions to a cell workspace.
 *
 * This is returned by `createCellWorkspace()` and allows adding extensions
 * with typed context based on the workspace definition.
 *
 * @typeParam TTableDefs - The table definitions from the workspace schema (array format)
 */
export type CellWorkspaceBuilder<
	TTableDefs extends readonly TableDefinition<
		readonly Field[]
	>[] = readonly TableDefinition<readonly Field[]>[],
> = {
	/**
	 * Add extensions that receive typed context based on the definition.
	 *
	 * Extensions can access `table('posts')` with type safety - TypeScript
	 * will error if you try to access a table that doesn't exist in the definition.
	 *
	 * @example
	 * ```typescript
	 * const workspace = createCellWorkspace({ headDoc, definition })
	 *   .withExtensions({
	 *     sqlite: (ctx) => {
	 *       ctx.table('posts');   // OK - 'posts' is in definition
	 *       ctx.table('invalid'); // TypeScript error!
	 *       return defineExports({ db });
	 *     },
	 *   });
	 *
	 * // workspace.extensions.sqlite.db is typed
	 * ```
	 */
	withExtensions<TExtensions extends CellExtensionFactoryMap<TTableDefs>>(
		extensions: TExtensions,
	): import('./types').CellWorkspaceClient<
		TTableDefs,
		InferCellExtensionExports<TExtensions>
	>;
};
