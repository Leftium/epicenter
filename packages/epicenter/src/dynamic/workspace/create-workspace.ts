/**
 * createWorkspace() - Instantiate a dynamic workspace client.
 *
 * Returns a client that IS usable directly AND has `.withExtensions()`.
 *
 * @example
 * ```typescript
 * // Direct use (no extensions)
 * const workspace = createWorkspace({ headDoc, definition });
 * workspace.tables.get('posts').upsert({ id: '1', title: 'Hello' });
 *
 * // With extensions
 * const workspace = createWorkspace({ headDoc, definition })
 *   .withExtensions({ sqlite, persistence });
 *
 * await workspace.whenSynced;
 * workspace.extensions.sqlite.db.select()...;
 * ```
 */

import * as Y from 'yjs';
import { defineExports, type Lifecycle } from '../../core/lifecycle';
import type { KvField, TableDefinition } from '../../core/schema/fields/types';
import { createKv } from '../kv/create-kv';
import { createTables } from '../tables/create-tables';
import type {
	CreateWorkspaceConfig,
	ExtensionContext,
	ExtensionFactoryMap,
	InferExtensionExports,
	WorkspaceClient,
	WorkspaceClientBuilder,
} from './types';

/**
 * Create a workspace client with optional extension chaining.
 *
 * Returns a client that IS directly usable AND has `.withExtensions()`
 * for adding extensions like persistence, SQLite, or sync.
 *
 * ## HeadDoc Integration
 *
 * The workspace derives its identity from the HeadDoc:
 * - `workspaceId` from `headDoc.workspaceId`
 * - `epoch` from `headDoc.getOwnEpoch()` (this client's epoch, not global max)
 *
 * Using `getOwnEpoch()` allows each client to view a different epoch. For example,
 * one client might be viewing epoch 2 while the global epoch is 3.
 *
 * ## Y.Doc Structure
 *
 * ```
 * Y.Doc (guid = `${workspaceId}-${epoch}`)
 * +-- Y.Array('table:posts')  <- Table data (LWW entries)
 * +-- Y.Array('table:users')  <- Another table
 * +-- Y.Array('kv')           <- KV settings (LWW entries)
 * ```
 *
 * @example Direct use (no extensions)
 * ```typescript
 * const workspace = createWorkspace({
 *   headDoc,
 *   definition: { name: 'Blog', tables: [...], kv: [...] },
 * });
 * workspace.tables.get('posts').upsert({ id: '1', title: 'Hello' });
 * ```
 *
 * @example With extensions
 * ```typescript
 * const workspace = createWorkspace({
 *   headDoc,
 *   definition,
 * }).withExtensions({
 *   sqlite: (ctx) => sqliteExtension(ctx),
 *   persistence: (ctx) => persistenceExtension(ctx),
 * });
 *
 * await workspace.whenSynced;
 * workspace.extensions.sqlite.db.select()...;
 * ```
 *
 * @param config - Configuration with headDoc and definition
 * @returns WorkspaceClientBuilder - a client that can be used directly or chained with .withExtensions()
 */
export function createWorkspace<
	const TTableDefinitions extends readonly TableDefinition[],
	const TKvFields extends readonly KvField[],
>(
	config: CreateWorkspaceConfig<TTableDefinitions, TKvFields>,
): WorkspaceClientBuilder<TTableDefinitions, TKvFields> {
	const { headDoc, definition } = config;

	// Extract identity from HeadDoc
	const workspaceId = headDoc.workspaceId;
	const epoch = headDoc.getOwnEpoch();

	// Create Y.Doc with guid = `${workspaceId}-${epoch}`
	// gc: false is required for revision history snapshots
	const docId = `${workspaceId}-${epoch}`;
	const ydoc = new Y.Doc({ guid: docId, gc: false });

	// Create table and KV helpers bound to Y.Doc
	const tables = createTables(ydoc, definition.tables ?? []);
	const kv = createKv(ydoc, definition.kv ?? []);

	// Base destroy (no extensions)
	const destroy = async (): Promise<void> => {
		ydoc.destroy();
	};

	// Build the base client (no extensions)
	const baseClient: WorkspaceClient<
		TTableDefinitions,
		TKvFields,
		Record<string, never>
	> = {
		workspaceId,
		epoch,
		ydoc,
		tables,
		kv,
		extensions: {} as InferExtensionExports<Record<string, never>>,
		whenSynced: Promise.resolve(), // No extensions = already synced
		destroy,
		[Symbol.asyncDispose]: destroy,
	};

	// Add withExtensions method to create builder
	return Object.assign(baseClient, {
		/**
		 * Add extensions to the workspace client.
		 *
		 * Each extension factory receives context and returns a Lifecycle object.
		 * The returned client has typed access to all extension exports.
		 */
		withExtensions<TExtensions extends ExtensionFactoryMap>(
			extensionFactories: TExtensions,
		): WorkspaceClient<TTableDefinitions, TKvFields, TExtensions> {
			// Initialize extensions synchronously; async work is in their whenSynced
			const extensions = {} as InferExtensionExports<TExtensions>;

			for (const [extensionId, factory] of Object.entries(extensionFactories)) {
				// Build context for this extension
				const context: ExtensionContext<TTableDefinitions, TKvFields> = {
					ydoc,
					workspaceId,
					epoch,
					tables,
					kv,
					extensionId,
				};

				// Factory is sync; normalize exports at boundary
				const result = factory(context);
				const exports = defineExports(result as Record<string, unknown>);
				(extensions as Record<string, unknown>)[extensionId] = exports;
			}

			// Aggregate all extension whenSynced promises
			// Fail-fast: any rejection rejects the whole thing
			const whenSynced = Promise.all(
				Object.values(extensions).map((e) => (e as Lifecycle).whenSynced),
			).then(() => {});

			// Cleanup must destroy extensions first, then Y.Doc
			const destroyWithExtensions = async (): Promise<void> => {
				await Promise.allSettled(
					Object.values(extensions).map((e) => (e as Lifecycle).destroy()),
				);
				ydoc.destroy();
			};

			return {
				workspaceId,
				epoch,
				ydoc,
				tables,
				kv,
				extensions,
				whenSynced,
				destroy: destroyWithExtensions,
				[Symbol.asyncDispose]: destroyWithExtensions,
			};
		},
	});
}

export type { WorkspaceClient, WorkspaceClientBuilder };
