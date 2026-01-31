/**
 * Grid Extension System
 *
 * Extensions add capabilities to a GridWorkspace (persistence, sync, SQLite materialization, etc.).
 * They receive typed context based on the workspace definition and must satisfy the Lifecycle protocol.
 *
 * @packageDocumentation
 */

import type * as Y from 'yjs';
import type { Lifecycle } from '../core/lifecycle';
import type {
	GridKvStore,
	GridTableDefinition,
	GridTableHelper,
	GridWorkspaceClient,
	GridWorkspaceDefinition,
} from './types';

/**
 * Context provided to grid extension factories.
 *
 * Extensions receive typed access to workspace resources. The `table()` method
 * is typed based on the workspace definition's table keys.
 */
export type GridExtensionContext<
	TTableDefs extends
		readonly GridTableDefinition[] = readonly GridTableDefinition[],
> = {
	/** The underlying Y.Doc instance */
	ydoc: Y.Doc;
	/** Workspace identifier (no epoch suffix) */
	workspaceId: string;
	/** Current epoch number (0 if no HeadDoc) */
	epoch: number;
	/** Get a table helper by ID (typed based on definition) */
	table<K extends TTableDefs[number]['id']>(tableId: K): GridTableHelper;
	table(tableId: string): GridTableHelper;
	/** KV store for workspace-level values */
	kv: GridKvStore;
	/** The full workspace definition */
	definition: GridWorkspaceDefinition;
	/** This extension's ID (the key in the extensions map) */
	extensionId: string;
};

/**
 * A grid extension factory function.
 *
 * Factories are **always synchronous**. Async initialization is tracked via
 * the returned `whenSynced` promise, not the factory itself.
 *
 * Use `defineExports()` to wrap your return for explicit type safety and
 * lifecycle normalization.
 *
 * @example Persistence extension
 * ```typescript
 * const persistence: GridExtensionFactory = (ctx) => {
 *   const provider = new IndexeddbPersistence(ctx.ydoc.guid, ctx.ydoc);
 *   return defineExports({
 *     whenSynced: provider.whenSynced,
 *     destroy: () => provider.destroy(),
 *   });
 * };
 * ```
 */
export type GridExtensionFactory<
	TTableDefs extends
		readonly GridTableDefinition[] = readonly GridTableDefinition[],
	TExports extends Lifecycle = Lifecycle,
> = (context: GridExtensionContext<TTableDefs>) => TExports;

/**
 * Map of extension factories keyed by extension ID.
 */
export type GridExtensionFactoryMap<
	TTableDefs extends
		readonly GridTableDefinition[] = readonly GridTableDefinition[],
> = Record<string, GridExtensionFactory<TTableDefs, Lifecycle>>;

/**
 * Infer extension exports from a factory map.
 */
export type InferGridExtensionExports<T> = {
	[K in keyof T]: T[K] extends GridExtensionFactory<
		infer _TTableDefs,
		infer TExports
	>
		? TExports
		: Lifecycle;
};

/**
 * Builder interface for adding extensions to a grid workspace.
 */
export type GridWorkspaceBuilder<
	TTableDefs extends
		readonly GridTableDefinition[] = readonly GridTableDefinition[],
> = {
	/**
	 * Add extensions that receive typed context based on the definition.
	 *
	 * Extensions can access `table('posts')` with type safety - TypeScript
	 * will error if you try to access a table that doesn't exist in the definition.
	 *
	 * @example
	 * ```typescript
	 * const workspace = createGridWorkspace({ id: 'blog', definition })
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
	withExtensions<TExtensions extends GridExtensionFactoryMap<TTableDefs>>(
		extensions: TExtensions,
	): GridWorkspaceClient<TTableDefs, InferGridExtensionExports<TExtensions>>;
};
