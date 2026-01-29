/**
 * Node.js/CLI convenience wrapper for workspace creation.
 *
 * This module provides an **async** version of `createClient()` for environments
 * where the "sync construction + render gate" pattern isn't needed. Instead of
 * returning immediately with a `whenSynced` promise, the Node version awaits
 * initialization internally and returns a fully-ready client.
 *
 * ## When to use this vs the browser version
 *
 * | Environment | Import | `createClient()` returns | Use case |
 * |-------------|--------|-------------------------|----------|
 * | Browser/UI | `@epicenter/hq` | `WorkspaceDoc` (sync) | Render gates, reactive UI |
 * | Node.js/CLI | `@epicenter/hq/node` | `Promise<WorkspaceDoc>` | Scripts, servers, migrations |
 *
 * ## Architecture
 *
 * This is a thin wrapper around the sync version from {@link ./workspace.ts}:
 *
 * ```
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  @epicenter/hq (browser)                                            │
 * │                                                                     │
 * │    createClient(head).withDefinition(definition).withExtensions({})  │
 * │         │                              │                            │
 * │         │                              └── UI awaits client.whenSynced
 * │         │                                                           │
 * └─────────│───────────────────────────────────────────────────────────┘
 *           │
 *           │  (wraps)
 *           ▼
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  @epicenter/hq/node (this module)                                   │
 * │                                                                     │
 * │    createClient(head).withDefinition(definition).withExtensions({}) │
 * │         │                              │                            │
 * │         │                              └── Promise<WorkspaceDoc>
 * │         │                                   whenSynced already resolved
 * │         │                                   (property omitted)      │
 * │         │                                                           │
 * │    Internally:                                                      │
 * │      const syncClient = createClientSync(...).withExtensions({});   │
 * │      await syncClient.whenSynced;                                   │
 * │      return { ...syncClient, whenSynced: undefined };               │
 * └─────────────────────────────────────────────────────────────────────┘
 * ```
 *
 * ## Implementation details
 *
 * The actual workspace creation logic lives in {@link ./workspace.ts | workspace.ts}:
 * - {@link defineWorkspace} - Type inference helper for workspace definitions (pass-through)
 * - {@link createClient} - Creates a runtime client builder (sync)
 * - {@link WorkspaceDoc} - The full client type with `whenSynced`
 *
 * This module simply:
 * 1. Re-exports `defineWorkspace` (pure pass-through for type inference)
 * 2. Wraps `createClient` so `.withExtensions()` returns a Promise
 * 3. Returns the client without the `whenSynced` property
 *
 * @example Basic usage
 * ```typescript
 * import { defineWorkspace, createClient, createHeadDoc, id, text, table } from '@epicenter/hq/node';
 *
 * const definition = defineWorkspace({
 *   tables: {
 *     posts: table('posts', { name: 'Posts', fields: [id(), text('title')] }),
 *   },
 *   kv: {},
 * });
 *
 * // Create head doc first
 * const head = createHeadDoc({ workspaceId: 'blog', providers: {} });
 *
 * // Async - awaits initialization internally
 * const client = await createClient(head)
 *   .withDefinition(definition)
 *   .withExtensions({ persistence });
 *
 * // Ready to use immediately
 * client.tables.get('posts').upsert({ id: '1', title: 'Hello' });
 * await client.destroy();
 * ```
 *
 * @example Migration script
 * ```typescript
 * import { defineWorkspace, createClient, createHeadDoc } from '@epicenter/hq/node';
 *
 * async function migrate() {
 *   const definition = defineWorkspace({ tables: {...}, kv: {} });
 *
 *   // Create separate head docs for each epoch
 *   const oldHead = createHeadDoc({ workspaceId: 'blog', providers: {} });
 *   oldHead.setOwnEpoch(1);
 *   const oldClient = await createClient(oldHead)
 *     .withDefinition(definition)
 *     .withExtensions({});
 *
 *   const newHead = createHeadDoc({ workspaceId: 'blog', providers: {} });
 *   newHead.setOwnEpoch(2);
 *   const newClient = await createClient(newHead)
 *     .withDefinition(definition)
 *     .withExtensions({});
 *
 *   for (const post of oldClient.tables.get('posts').getAllValid()) {
 *     newClient.tables.get('posts').upsert(migratePost(post));
 *   }
 *
 *   await oldClient.destroy();
 *   await newClient.destroy();
 * }
 * ```
 *
 * @see {@link defineWorkspace} - Type inference helper for workspace definitions
 *
 * @see {@link ./workspace.ts} - The sync implementation that powers this wrapper
 * @see {@link ../lifecycle.ts} - The Lifecycle protocol (`whenSynced`, `destroy`)
 * @see {@link ../extension.ts} - Extension factory types
 *
 * @module
 */

import type { HeadDoc } from '../docs/head-doc';
import type {
	ExtensionExports,
	WorkspaceDoc as WorkspaceDocSync,
} from '../docs/workspace-doc';
import type { ExtensionFactoryMap, InferExtensionExports } from '../extension';
import type { KvField, TableDefinition } from '../schema';
import {
	type ClientBuilder as ClientBuilderSync,
	createClient as createClientSync,
	type WorkspaceDefinition,
} from './workspace';

/**
 * Workspace type for Node.js environments.
 *
 * This type is derived from the browser {@link WorkspaceDocSync | WorkspaceDoc}
 * with the `whenSynced` property omitted. Since the Node.js `createClient()` function
 * awaits initialization internally, `whenSynced` has already resolved by the
 * time you receive the workspace.
 *
 * ## Relationship to browser workspace
 *
 * ```
 * WorkspaceDoc (browser)                 WorkspaceDoc (node)
 * ├── workspaceId: string                ├── workspaceId: string
 * ├── epoch: number                      ├── epoch: number
 * ├── tables: Tables                     ├── tables: Tables
 * ├── kv: Kv<K>                          ├── kv: Kv<K>
 * ├── extensions: E                      ├── extensions: E
 * ├── ydoc: Y.Doc                        ├── ydoc: Y.Doc
 * ├── whenSynced: Promise<void>  ──────► (omitted - already resolved)
 * ├── destroy(): Promise<void>           ├── destroy(): Promise<void>
 * └── [Symbol.asyncDispose]              └── [Symbol.asyncDispose]
 * ```
 *
 * Note: Workspace identity (name, icon, description) comes from HeadDoc.getMeta(),
 * not from the workspace.
 *
 * ## Why omit `whenSynced`?
 *
 * In browser/UI contexts, `whenSynced` enables the render gate pattern:
 *
 * ```svelte
 * {#await workspace.whenSynced}
 *   <Loading />
 * {:then}
 *   <App />
 * {/await}
 * ```
 *
 * In Node.js scripts, this pattern isn't useful. You just want to `await`
 * creation and start working. So we await internally and remove the property
 * to signal "this workspace is ready."
 *
 * @see {@link WorkspaceDocSync} - The browser version with `whenSynced`
 * @see {@link ../docs/workspace-doc.ts} - Where `WorkspaceDocSync` is defined
 */
export type WorkspaceDoc<
	TTableDefinitions extends
		readonly TableDefinition[] = readonly TableDefinition[],
	TKvFields extends readonly KvField[] = readonly KvField[],
	TExtensionExports extends Record<string, ExtensionExports> = Record<
		string,
		ExtensionExports
	>,
> = Omit<
	WorkspaceDocSync<TTableDefinitions, TKvFields, TExtensionExports>,
	'whenSynced'
>;

/**
 * Async builder for creating workspace clients in Node.js.
 *
 * The builder pattern solves TypeScript's limitation with simultaneous generic
 * inference. By splitting client creation into sequential method calls, TypeScript
 * can infer types step-by-step.
 *
 * ## Two Paths
 *
 * ```
 *                          createClient(head)
 *                               │
 *                               ▼
 *               ┌───────────────┴───────────────┐
 *               │                               │
 *               ▼                               ▼
 *      .withDefinition(definition)       .withExtensions({})
 *               │                               │
 *               │                               │
 *               ▼                               ▼
 *      .withExtensions({})          Promise<WorkspaceDoc>
 *               │                        (dynamic definition)
 *               │
 *               ▼
 *     Promise<WorkspaceDoc>
 *        (static definition)
 * ```
 *
 * ## Why async methods?
 *
 * The `.withExtensions()` method returns a Promise that awaits `whenSynced` internally.
 * This matches the Node.js philosophy of awaiting initialization before returning.
 */
export type ClientBuilder<
	TTableDefinitions extends readonly TableDefinition[],
	TKvFields extends readonly KvField[],
> = {
	/**
	 * Attach a workspace definition for static definition mode.
	 *
	 * This locks in the table/kv types from the definition, enabling
	 * proper type inference for extensions.
	 *
	 * @example
	 * ```typescript
	 * const definition = defineWorkspace({ tables: [...], kv: [...] });
	 * const head = createHeadDoc({ workspaceId: 'blog', providers: {} });
	 *
	 * const client = await createClient(head)
	 *   .withDefinition(definition)
	 *   .withExtensions({
	 *     persistence: (ctx) => persistence(ctx, { filePath }),
	 *   });
	 * ```
	 */
	withDefinition<
		TDefinitionTables extends readonly TableDefinition[],
		TDefinitionKv extends readonly KvField[],
	>(
		definition: WorkspaceDefinition<TDefinitionTables, TDefinitionKv>,
	): ClientBuilder<TDefinitionTables, TDefinitionKv>;

	/**
	 * Attach extensions and create the client.
	 *
	 * This is the terminal operation that creates the actual WorkspaceDoc.
	 * The returned Promise resolves after all extensions have completed their `whenSynced`.
	 *
	 * Pass an empty object `{}` if you don't need any extensions.
	 *
	 * @example
	 * ```typescript
	 * // With extensions
	 * const definition = defineWorkspace({ tables: [...], kv: [...] });
	 * const head = createHeadDoc({ workspaceId: 'blog', providers: {} });
	 *
	 * const client = await createClient(head)
	 *   .withDefinition(definition)
	 *   .withExtensions({
	 *     persistence: (ctx) => persistence(ctx, { filePath }),
	 *     sqlite: (ctx) => sqlite(ctx, { dbPath }),
	 *   });
	 *
	 * client.tables.posts.upsert({ ... });
	 *
	 * // Without extensions
	 * const head = createHeadDoc({ workspaceId: 'blog', providers: {} });
	 * const client = await createClient(head)
	 *   .withDefinition(definition)
	 *   .withExtensions({});
	 * ```
	 */
	withExtensions<
		TExtensionFactories extends ExtensionFactoryMap<
			TTableDefinitions,
			TKvFields
		>,
	>(
		extensions: TExtensionFactories,
	): Promise<
		WorkspaceDoc<
			TTableDefinitions,
			TKvFields,
			InferExtensionExports<TExtensionFactories>
		>
	>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Public API: createClient with Builder Pattern (Node.js async version)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create an async client builder for a workspace.
 *
 * Returns a {@link ClientBuilder} for chaining `.withDefinition()` and `.withExtensions()`.
 * The client is only created when you call `.withExtensions()` (the terminal operation).
 *
 * ## Two Paths
 *
 * ```
 *                          createClient(head)
 *                               │
 *                               ▼
 *               ┌───────────────┴───────────────┐
 *               │                               │
 *               ▼                               ▼
 *      .withDefinition(definition)       .withExtensions({})
 *               │                               │
 *               │                               │
 *               ▼                               ▼
 *      .withExtensions({})          Promise<WorkspaceDoc>
 *               │                        (dynamic definition)
 *               │
 *               ▼
 *     Promise<WorkspaceDoc>
 *        (static definition)
 * ```
 *
 * ## Path 1: Static Definition (Code-Defined)
 *
 * For apps like Whispering where definition is defined in code:
 *
 * ```typescript
 * const definition = defineWorkspace({
 *   tables: { recordings: table('recordings', { name: 'Recordings', fields: [id(), text('title')] }) },
 *   kv: {},
 * });
 *
 * const head = createHeadDoc({ workspaceId: 'epicenter-whispering', providers: {} });
 * const client = await createClient(head)
 *   .withDefinition(definition)
 *   .withExtensions({
 *     persistence: (ctx) => persistence(ctx, { filePath }),
 *   });
 *
 * // Ready to use immediately (no whenSynced needed)
 * client.tables.recordings.upsert({ ... });
 * ```
 *
 * Note: Workspace identity (name, icon, description) is separate from definition
 * and should be managed via Head Doc.
 *
 * ## Path 2: Dynamic Definition (Y.Doc-Defined)
 *
 * For the Epicenter app where definition lives in the Y.Doc:
 *
 * ```typescript
 * const head = createHeadDoc({ workspaceId: 'my-workspace', providers: {} });
 * head.setOwnEpoch(2); // Time travel to epoch 2
 * const client = await createClient(head)
 *   .withExtensions({
 *     persistence: (ctx) => persistence(ctx, { filePath }),
 *   });
 * ```
 *
 * ## Without Extensions
 *
 * Pass an empty object to `.withExtensions()`:
 *
 * ```typescript
 * const definition = defineWorkspace({ tables: {...}, kv: {} });
 * const head = createHeadDoc({ workspaceId: 'blog', providers: {} });
 * const client = await createClient(head)
 *   .withDefinition(definition)
 *   .withExtensions({});
 * ```
 *
 * @param head - The HeadDoc containing workspace identity and current epoch
 */
export function createClient(
	head: HeadDoc,
): ClientBuilder<readonly TableDefinition[], readonly KvField[]> {
	// Get the sync builder from workspace.ts
	const syncBuilder = createClientSync(head);

	// Return async builder that wraps the sync builder
	return createAsyncClientBuilder(syncBuilder);
}

/**
 * Internal: Create an async ClientBuilder that wraps a sync ClientBuilder.
 */
function createAsyncClientBuilder<
	TTableDefinitions extends readonly TableDefinition[],
	TKvFields extends readonly KvField[],
>(
	syncBuilder: ClientBuilderSync<TTableDefinitions, TKvFields>,
): ClientBuilder<TTableDefinitions, TKvFields> {
	return {
		withDefinition<
			TDefinitionTables extends readonly TableDefinition[],
			TDefinitionKv extends readonly KvField[],
		>(
			definition: WorkspaceDefinition<TDefinitionTables, TDefinitionKv>,
		): ClientBuilder<TDefinitionTables, TDefinitionKv> {
			const newSyncBuilder = syncBuilder.withDefinition(definition);
			return createAsyncClientBuilder(newSyncBuilder);
		},

		async withExtensions<
			TExtFact extends ExtensionFactoryMap<TTableDefinitions, TKvFields>,
		>(
			extensions: TExtFact,
		): Promise<
			WorkspaceDoc<
				TTableDefinitions,
				TKvFields,
				InferExtensionExports<TExtFact>
			>
		> {
			const syncClient = syncBuilder.withExtensions(extensions);
			await syncClient.whenSynced;
			const { whenSynced: _, ...clientWithoutWhenSynced } = syncClient;
			return clientWithoutWhenSynced;
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Re-exports
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Re-export field schema factories for defining workspace tables.
 *
 * These are the building blocks for table definitions:
 *
 * ```typescript
 * import { defineWorkspace, createClient, createHeadDoc, id, text, boolean, date, table } from '@epicenter/hq/node';
 *
 * const definition = defineWorkspace({
 *   tables: {
 *     posts: table('posts', {
 *       name: 'Posts',
 *       fields: [
 *         id(),           // Primary key (always required)
 *         text('title'),  // NOT NULL text
 *         boolean('published', { default: false }),
 *         date('createdAt'),  // Temporal-aware date with timezone
 *       ],
 *     }),
 *   },
 *   kv: {},
 * });
 *
 * const head = createHeadDoc({ workspaceId: 'epicenter-blog', providers: {} });
 * const client = await createClient(head)
 *   .withDefinition(definition)
 *   .withExtensions({ persistence });
 * ```
 *
 * @see {@link ../schema/fields/factories.ts} - Field factory implementations
 * @see {@link ../schema/fields/types.ts} - Field type definitions
 */
export {
	// Field factories for table definitions
	boolean,
	// Icon utilities
	createIcon,
	date,
	// ID generation utilities
	generateGuid,
	generateId,
	id,
	integer,
	isIcon,
	json,
	parseIcon,
	real,
	richtext,
	select,
	table,
	tags,
	text,
} from '../schema';

/**
 * Re-export types from workspace.ts for consumers of the Node entrypoint.
 *
 * @see {@link ./workspace.ts} - Where these types are defined
 */
export type { WorkspaceDefinition } from './workspace';

/**
 * Re-export defineWorkspace from workspace.ts.
 *
 * `defineWorkspace` is a pure pass-through for type inference. It performs no
 * normalization or transformation.
 */
export { defineWorkspace } from './workspace';
