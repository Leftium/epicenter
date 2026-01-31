/**
 * Dynamic Extension System
 *
 * Extensions add capabilities to a Workspace (persistence, sync, SQLite materialization, etc.).
 * They receive typed context based on the workspace definition and must satisfy the Lifecycle protocol.
 *
 * @packageDocumentation
 */

import type * as Y from 'yjs';
import type { Lifecycle } from '../core/lifecycle';
import type {
	KvStore,
	TableDef,
	TableHelper,
	WorkspaceClient,
	WorkspaceDef,
} from './types';

/**
 * Context provided to extension factories.
 *
 * Extensions receive typed access to workspace resources. The `table()` method
 * is typed based on the workspace definition's table keys.
 */
export type ExtensionContext<
	TTableDefs extends readonly TableDef[] = readonly TableDef[],
> = {
	/** The underlying Y.Doc instance */
	ydoc: Y.Doc;
	/** Workspace identifier (no epoch suffix) */
	workspaceId: string;
	/** Current epoch number (0 if no HeadDoc) */
	epoch: number;
	/** Get a table helper by ID (typed based on definition) */
	table<K extends TTableDefs[number]['id']>(tableId: K): TableHelper;
	table(tableId: string): TableHelper;
	/** KV store for workspace-level values */
	kv: KvStore;
	/** The full workspace definition */
	definition: WorkspaceDef;
	/** This extension's ID (the key in the extensions map) */
	extensionId: string;
};

/**
 * An extension factory function.
 *
 * Factories are **always synchronous**. Async initialization is tracked via
 * the returned `whenSynced` promise, not the factory itself.
 *
 * Use `defineExports()` to wrap your return for explicit type safety and
 * lifecycle normalization.
 *
 * @example Persistence extension
 * ```typescript
 * import { createWorkspace, defineExports } from '@epicenter/hq/dynamic';
 *
 * const persistence: ExtensionFactory = (ctx) => {
 *   const provider = new IndexeddbPersistence(ctx.ydoc.guid, ctx.ydoc);
 *   return defineExports({
 *     whenSynced: provider.whenSynced,
 *     destroy: () => provider.destroy(),
 *   });
 * };
 * ```
 */
export type ExtensionFactory<
	TTableDefs extends readonly TableDef[] = readonly TableDef[],
	TExports extends Lifecycle = Lifecycle,
> = (context: ExtensionContext<TTableDefs>) => TExports;

/**
 * Map of extension factories keyed by extension ID.
 */
export type ExtensionFactoryMap<
	TTableDefs extends readonly TableDef[] = readonly TableDef[],
> = Record<string, ExtensionFactory<TTableDefs, Lifecycle>>;

/**
 * Infer extension exports from a factory map.
 */
export type InferExtensionExports<T> = {
	[K in keyof T]: T[K] extends ExtensionFactory<infer _TTableDefs, infer TExports>
		? TExports
		: Lifecycle;
};

/**
 * Builder interface for adding extensions to a workspace.
 */
export type WorkspaceBuilder<
	TTableDefs extends readonly TableDef[] = readonly TableDef[],
> = {
	/**
	 * Add extensions that receive typed context based on the definition.
	 *
	 * Extensions can access `table('posts')` with type safety - TypeScript
	 * will error if you try to access a table that doesn't exist in the definition.
	 *
	 * @example
	 * ```typescript
	 * import { createWorkspace, defineExports } from '@epicenter/hq/dynamic';
	 *
	 * const workspace = createWorkspace({ id: 'blog', definition })
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
	withExtensions<TExtensions extends ExtensionFactoryMap<TTableDefs>>(
		extensions: TExtensions,
	): WorkspaceClient<TTableDefs, InferExtensionExports<TExtensions>>;
};
