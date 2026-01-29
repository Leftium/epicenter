/**
 * Workspace definition and creation for YJS-first collaborative workspaces.
 *
 * This module provides the core workspace API:
 * - {@link defineWorkspace} - Type inference helper for workspace definitions (pass-through)
 * - {@link createClient} - Factory to create workspaces with builder pattern
 * - {@link WorkspaceDoc} - The unified workspace abstraction (from workspace-doc.ts)
 * - {@link WorkspaceDefinition} - Definition type for `.withDefinition()` (tables + kv only)
 *
 * ## Architecture Overview
 *
 * ```
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │  Builder Pattern Initialization                                             │
 * │                                                                             │
 * │   createClient(head)                                                        │
 * │         │                                                                   │
 * │         ▼                                                                   │
 * │         ┌───────────┴───────────┐                                           │
 * │         │                       │                                           │
 * │         ▼                       ▼                                           │
 * │   .withDefinition(definition)  .withExtensions({})                          │
 * │         │                       │                                           │
 * │         ▼                       ▼                                           │
 * │   .withExtensions({})       WorkspaceDoc                                    │
 * │         │                   (dynamic definition)                            │
 * │         ▼                                                                   │
 * │   WorkspaceDoc                                                              │
 * │   (static definition)                                                       │
 * └─────────────────────────────────────────────────────────────────────────────┘
 * ```
 *
 * ## Sync Construction Pattern
 *
 * This module implements the "sync construction, async property" pattern:
 *
 * - `createClient()` returns **immediately** with a workspace object
 * - Async initialization (persistence, sync) tracked via `workspace.whenSynced`
 * - UI frameworks use `whenSynced` as a render gate
 *
 * ```typescript
 * // Create head doc first (manages epoch)
 * const head = createHeadDoc({ workspaceId: 'blog', providers: {} });
 *
 * // Sync construction - returns immediately
 * const workspace = createClient(head)
 *   .withDefinition({ tables: {...}, kv: {} })
 *   .withExtensions({ persistence });
 *
 * // Sync access works immediately (operates on in-memory Y.Doc)
 * workspace.tables.get('posts').upsert({ id: '1', title: 'Hello' });
 *
 * // Await when you need initialization complete
 * await workspace.whenSynced;
 * ```
 *
 * For Node.js scripts that prefer async semantics, see {@link ./node.ts}.
 *
 * ## Related Modules
 *
 * - {@link ../lifecycle.ts} - Lifecycle protocol (`whenSynced`, `destroy`)
 * - {@link ../extension.ts} - Extension factory types
 * - {@link ../docs/head-doc.ts} - Head Doc for workspace identity and epoch
 * - {@link ../docs/registry-doc.ts} - Registry Doc for workspace discovery
 * - {@link ../docs/workspace-doc.ts} - WorkspaceDoc type definition
 * - {@link ./node.ts} - Node.js async wrapper
 *
 * @module
 */

import type { HeadDoc } from '../docs/head-doc';
import {
	createWorkspaceDoc,
	type ExtensionFactoryMap,
	type InferExtensionExports,
	type WorkspaceDoc,
} from '../docs/workspace-doc';

import type {
	Icon,
	KvDefinitionMap,
	TableDefinitionMap,
} from '../schema/fields/types';

// ─────────────────────────────────────────────────────────────────────────────
// Public API: Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Complete workspace definition including identity and schema.
 *
 * Contains workspace identity (name, description, icon) alongside
 * table and KV definitions. This is the "lens" through which data is viewed.
 *
 * The data itself is separate from the definition - this enables:
 * - Multiple definitions viewing the same data differently
 * - Advisory validation (data flagged, not rejected)
 * - Schema evolution without data migration
 *
 * @example
 * ```typescript
 * const definition: WorkspaceDefinition = {
 *   name: 'My Blog',
 *   description: 'Personal blog workspace',
 *   icon: 'emoji:📝',
 *   tables: {
 *     posts: table({ name: 'Posts', fields: { id: id(), title: text() } }),
 *   },
 *   kv: {},
 * };
 * ```
 */
export type WorkspaceDefinition<
	TTableDefinitionMap extends TableDefinitionMap = TableDefinitionMap,
	TKvDefinitionMap extends KvDefinitionMap = KvDefinitionMap,
> = {
	/** Display name of the workspace */
	name: string;
	/** Description of the workspace */
	description: string;
	/** Icon for the workspace - tagged string format 'type:value' or null */
	icon: Icon | null;
	/** Table definitions with metadata (name, icon, description, fields). */
	tables: TTableDefinitionMap;
	/** KV definitions for workspace-level settings. */
	kv: TKvDefinitionMap;
};

/**
 * Builder for creating workspace clients with proper type inference.
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
 *      .withDefinition(definition)      .withExtensions({})
 *               │                               │
 *               │                               │
 *               ▼                               ▼
 *      .withExtensions({})               WorkspaceClient
 *               │                        (dynamic definition)
 *               │
 *               ▼
 *        WorkspaceClient
 *        (static definition)
 * ```
 *
 * **Path 1: Static Definition (Code-Defined)**
 *
 * For apps like Whispering where definition is defined in code:
 *
 * ```typescript
 * const head = createHeadDoc({ workspaceId: 'whispering', providers: {} });
 * const client = createClient(head)
 *   .withDefinition({ tables: {...}, kv: {} })
 *   .withExtensions({
 *     persistence: (ctx) => persistence(ctx, { filePath }),
 *   });
 * ```
 *
 * **Path 2: Dynamic Definition (Y.Doc-Defined)**
 *
 * For the Epicenter app where definition lives in the Y.Doc:
 *
 * ```typescript
 * const head = createHeadDoc({ workspaceId: 'my-workspace', providers: {} });
 * const client = createClient(head)
 *   .withExtensions({
 *     persistence: (ctx) => persistence(ctx, { filePath }),
 *     //            ^^^ ctx: ExtensionContext<TableDefinitionMap, KvDefinitionMap> (generic)
 *   });
 * ```
 *
 * **Without Extensions**
 *
 * Pass an empty object to `.withExtensions()`:
 *
 * ```typescript
 * const head = createHeadDoc({ workspaceId: 'blog', providers: {} });
 * const client = createClient(head)
 *   .withDefinition({ tables: {...}, kv: {} })
 *   .withExtensions({});
 * ```
 */
export type ClientBuilder<
	TTableDefinitionMap extends TableDefinitionMap,
	TKvDefinitionMap extends KvDefinitionMap,
> = {
	/**
	 * Attach a workspace definition for static definition mode.
	 *
	 * This locks in the table/kv types from the definition, enabling
	 * proper type inference for extensions.
	 *
	 * Note: Workspace identity (id, name, icon, description) is now separate
	 * from definition and lives in the Head Doc.
	 *
	 * @example
	 * ```typescript
	 * const head = createHeadDoc({ workspaceId: 'blog', providers: {} });
	 * const client = createClient(head)
	 *   .withDefinition({ tables: {...}, kv: {} })
	 *   .withExtensions({
	 *     persistence: (ctx) => persistence(ctx, { filePath }),
	 *   });
	 * ```
	 */
	withDefinition<
		TDefinitionTables extends TableDefinitionMap,
		TDefinitionKv extends KvDefinitionMap,
	>(
		definition: WorkspaceDefinition<TDefinitionTables, TDefinitionKv>,
	): ClientBuilder<TDefinitionTables, TDefinitionKv>;

	/**
	 * Attach extensions and create the workspace.
	 *
	 * This is the terminal operation that creates the actual WorkspaceDoc.
	 * Extensions receive properly typed context with table and kv definitions.
	 *
	 * Pass an empty object `{}` if you don't need any extensions.
	 *
	 * @example
	 * ```typescript
	 * // With extensions
	 * const head = createHeadDoc({ workspaceId: 'whispering', providers: {} });
	 * const workspace = createClient(head)
	 *   .withDefinition({ tables: {...}, kv: {} })
	 *   .withExtensions({
	 *     persistence: (ctx) => persistence(ctx, { filePath }),
	 *     sqlite: (ctx) => sqlite(ctx, { dbPath }),
	 *   });
	 *
	 * await workspace.whenSynced;
	 * workspace.tables.recordings.upsert({ ... });
	 *
	 * // Without extensions
	 * const head = createHeadDoc({ workspaceId: 'blog', providers: {} });
	 * const workspace = createClient(head)
	 *   .withDefinition({ tables: {...}, kv: {} })
	 *   .withExtensions({});
	 * ```
	 */
	withExtensions<
		TExtensionFactories extends ExtensionFactoryMap<
			TTableDefinitionMap,
			TKvDefinitionMap
		>,
	>(
		extensions: TExtensionFactories,
	): WorkspaceDoc<
		TTableDefinitionMap,
		TKvDefinitionMap,
		InferExtensionExports<TExtensionFactories>
	>;
};

// WorkspaceClient type has been consolidated into WorkspaceDoc
// See: workspace-doc.ts for the unified WorkspaceDoc type

// ─────────────────────────────────────────────────────────────────────────────
// Public API: Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Define a workspace definition for type inference.
 *
 * This is a simple pass-through function that helps TypeScript infer
 * the definition types. It performs no normalization or transformation.
 *
 * @deprecated Use `createCellWorkspace` from `@epicenter/hq` or `@epicenter/hq/cell` instead.
 * The Cell API provides cell-level CRDT (better concurrent editing) and a simpler builder pattern.
 *
 * @example
 * ```typescript
 * // Old API (deprecated)
 * const definition = defineWorkspace({
 *   tables: {
 *     posts: table({
 *       name: 'Posts',
 *       fields: { id: id(), title: text(), published: boolean({ default: false }) },
 *     }),
 *   },
 *   kv: {},
 * });
 *
 * // New API (recommended)
 * const workspace = createCellWorkspace({
 *   headDoc,
 *   definition: {
 *     name: 'Blog',
 *     tables: {
 *       posts: { name: 'Posts', fields: { title: { name: 'Title', type: 'text', order: 1 } } },
 *     },
 *   },
 * }).withExtensions({});
 * ```
 *
 * @param definition - The workspace definition with tables and kv definitions
 * @returns The same definition, unchanged (for type inference)
 */
export function defineWorkspace<
	const TTables extends TableDefinitionMap,
	const TKv extends KvDefinitionMap = Record<string, never>,
>(
	definition: WorkspaceDefinition<TTables, TKv>,
): WorkspaceDefinition<TTables, TKv> {
	return definition;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API: createClient with Builder Pattern
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a client builder for a workspace.
 *
 * @deprecated Use `createCellWorkspace` from `@epicenter/hq` or `@epicenter/hq/cell` instead.
 * The Cell API provides:
 * - Cell-level CRDT (better concurrent editing than row-level)
 * - HeadDoc integration for epoch/time-travel support
 * - Builder pattern with typed extensions
 *
 * ## Migration Example
 *
 * ```typescript
 * // Old API (deprecated)
 * const client = createClient(head)
 *   .withDefinition({ tables: {...}, kv: {} })
 *   .withExtensions({ persistence });
 *
 * // New API (recommended)
 * const workspace = createCellWorkspace({
 *   headDoc,
 *   definition: { name: 'My Workspace', tables: {...} },
 * }).withExtensions({ persistence });
 * ```
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
 *      .withDefinition(definition)      .withExtensions({})
 *               │                               │
 *               │                               │
 *               ▼                               ▼
 *      .withExtensions({})               WorkspaceClient
 *               │                        (dynamic definition)
 *               │
 *               ▼
 *        WorkspaceClient
 *        (static definition)
 * ```
 *
 * ## Path 1: Static Definition (Code-Defined)
 *
 * For apps like Whispering where definition is defined in code:
 *
 * ```typescript
 * const head = createHeadDoc({ workspaceId: 'whispering', providers: {} });
 * const client = createClient(head)
 *   .withDefinition({
 *     tables: { recordings: table({ name: 'Recordings', fields: { id: id(), title: text() } }) },
 *     kv: {},
 *   })
 *   .withExtensions({
 *     persistence: (ctx) => persistence(ctx, { filePath }),
 *   });
 *
 * await client.whenSynced;
 * client.tables.recordings.upsert({ ... });
 * ```
 *
 * ## Path 2: Dynamic Definition (Y.Doc-Defined)
 *
 * For the Epicenter app where definition lives in the Y.Doc:
 *
 * ```typescript
 * const head = createHeadDoc({ workspaceId: 'my-workspace', providers: {} });
 * head.setOwnEpoch(2); // Time travel to epoch 2
 * const client = createClient(head)
 *   .withExtensions({
 *     persistence: (ctx) => persistence(ctx, { filePath }),
 *   });
 *
 * await client.whenSynced;
 * // Definition is read from Y.Doc after persistence loads
 * ```
 *
 * ## Without Extensions
 *
 * Pass an empty object to `.withExtensions()`:
 *
 * ```typescript
 * const head = createHeadDoc({ workspaceId: 'blog', providers: {} });
 * const client = createClient(head)
 *   .withDefinition({ tables: {...}, kv: {} })
 *   .withExtensions({});
 * ```
 *
 * @param head - The HeadDoc containing workspace identity and current epoch
 */
export function createClient(
	head: HeadDoc,
): ClientBuilder<TableDefinitionMap, KvDefinitionMap> {
	return createClientBuilder({
		id: head.workspaceId,
		epoch: head.getEpoch(),
		tables: {} as TableDefinitionMap,
		kv: {} as KvDefinitionMap,
	});
}

/**
 * Internal: Create a ClientBuilder from builder config.
 *
 * The builder accumulates `tables` and `kv` definitions through `.withDefinition()`.
 * When `.withExtensions()` is called, these are passed to `createWorkspaceDoc()`
 * which handles both creating typed helpers AND merging definition after sync.
 */
function createClientBuilder<
	TTableDefinitionMap extends TableDefinitionMap,
	TKvDefinitionMap extends KvDefinitionMap,
>(config: {
	id: string;
	epoch: number;
	tables: TTableDefinitionMap;
	kv: TKvDefinitionMap;
}): ClientBuilder<TTableDefinitionMap, TKvDefinitionMap> {
	return {
		withDefinition<
			TDefinitionTables extends TableDefinitionMap,
			TDefinitionKv extends KvDefinitionMap,
		>(
			definition: WorkspaceDefinition<TDefinitionTables, TDefinitionKv>,
		): ClientBuilder<TDefinitionTables, TDefinitionKv> {
			return createClientBuilder({
				id: config.id,
				epoch: config.epoch,
				tables: definition.tables,
				kv: definition.kv,
			});
		},

		withExtensions<
			TExtensionFactories extends ExtensionFactoryMap<
				TTableDefinitionMap,
				TKvDefinitionMap
			>,
		>(
			extensions: TExtensionFactories,
		): WorkspaceDoc<
			TTableDefinitionMap,
			TKvDefinitionMap,
			InferExtensionExports<TExtensionFactories>
		> {
			// createWorkspaceDoc handles both:
			// 1. Creating typed table/kv helpers from definitions
			// 2. Merging definition into Y.Doc after extensions sync
			return createWorkspaceDoc({
				workspaceId: config.id,
				epoch: config.epoch,
				tables: config.tables,
				kv: config.kv,
				extensionFactories: extensions,
			});
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Y.Doc Structure: Three Top-Level Maps
// ─────────────────────────────────────────────────────────────────────────────
//
// HEAD DOC (per workspace, all epochs)
// Y.Map('meta') - Workspace identity
//   └── name: string
//   └── icon: Icon | null
//   └── description: string
// Y.Map('epochs') - Epoch tracking
//   └── [clientId]: number
//
// WORKSPACE DOC (per epoch)
// Y.Map('definition') - Table/KV definitions (rarely changes)
//   └── tables: Y.Map<tableName, { name, icon, description, fields }>
//   └── kv: Y.Map<keyName, { name, icon, description, field }>
//
// Y.Map('kv') - Settings values (changes occasionally)
//   └── [key]: value
//
// Y.Map('tables') - Table data (changes frequently)
//   └── [tableName]: Y.Map<rowId, Y.Map<fieldName, value>>
//
// This enables:
// - Independent observation (no observeDeep needed)
// - Different persistence strategies per map
// - Collaborative definition editing via Y.Map('definition')
// - Workspace identity (name/icon) shared across all epochs
//
// See specs/20260121T231500-doc-architecture-v2.md for details.
