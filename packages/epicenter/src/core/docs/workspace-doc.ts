import * as Y from 'yjs';
import { createDefinition, type Definition } from '../definition-helper';
import { createKv, type Kv } from '../kv/core';
import { defineExports, type Lifecycle } from '../lifecycle';
import type {
	KvDefinitionMap, // Deprecated but kept for backward compat in type params
	KvValue,
	TableDefinitionMap, // Deprecated but kept for backward compat in type params
} from '../schema/fields/types';
import { createTables, type Tables } from '../tables/create-tables';

// ─────────────────────────────────────────────────────────────────────────────
// Y.Doc Top-Level Map Names
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The three top-level Y.Map names in a Workspace Y.Doc.
 *
 * Each workspace epoch has a single Y.Doc with three top-level maps:
 * - `definition`: Table/KV definitions (field schemas, table metadata)
 * - `kv`: Settings values (actual KV data)
 * - `tables`: Table data (rows organized by table name)
 *
 * Note: Workspace-level identity (name, icon, description) lives in the
 * Head Doc's `meta` map, NOT here. This ensures renaming applies to all epochs.
 *
 * This 1:1 mapping enables independent observation and different persistence
 * strategies per map.
 */
export const WORKSPACE_DOC_MAPS = {
	/** Table/KV definitions. Rarely changes. */
	DEFINITION: 'definition',
	/** Settings values. Changes occasionally. Persisted to kv.json */
	KV: 'kv',
	/** Table row data. Changes frequently. Persisted to tables.sqlite */
	TABLES: 'tables',
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Type Definitions for Y.Doc Structure
// ─────────────────────────────────────────────────────────────────────────────

import type { Icon } from '../schema/fields/types.js';

/**
 * The structure stored in Y.Map('definition') in the Workspace Doc.
 *
 * Contains table and KV definitions (NOT workspace identity).
 * Workspace identity (name, icon, description) lives in the Head Doc's `meta` map.
 *
 * @see WorkspaceMeta in head-doc.ts for workspace identity
 */
export type WorkspaceDefinitionMap = {
	/** Table definitions (name, icon, description, fields) */
	tables: {
		[tableName: string]: {
			name: string;
			icon: Icon | null;
			description: string;
			fields: Record<string, unknown>; // Field objects
		};
	};
	/** KV definitions (name, icon, description, field) */
	kv: {
		[key: string]: {
			name: string;
			icon: Icon | null;
			description: string;
			field: unknown; // Field object
		};
	};
};

// ─────────────────────────────────────────────────────────────────────────────
// Y.Map Type Aliases
// ─────────────────────────────────────────────────────────────────────────────

/** Y.Map storing cell values for a single row, keyed by column name. */
export type RowYMap = Y.Map<unknown>;

/** Y.Map storing rows for a single table, keyed by row ID. */
export type TableYMap = Y.Map<RowYMap>;

/** Y.Map storing all tables, keyed by table name. */
export type TablesYMap = Y.Map<TableYMap>;

/** Y.Map storing KV values, keyed by key name. */
export type KvYMap = Y.Map<KvValue>;

/** Y.Map storing workspace definition (tables and kv definitions). */
export type DefinitionYMap = Y.Map<unknown>;

// ─────────────────────────────────────────────────────────────────────────────
// Extension Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extension exports - returned values accessible via `workspace.extensions.{name}`.
 *
 * This type combines the lifecycle protocol with custom exports.
 * The framework guarantees `whenSynced` and `destroy` exist on all extensions.
 */
export type ExtensionExports<T extends Record<string, unknown> = {}> =
	Lifecycle & T;

/**
 * An extension factory function that attaches functionality to a workspace.
 *
 * Receives a flattened context with all workspace data directly accessible.
 * Factories are **always synchronous**. Async initialization is tracked via
 * the returned `whenSynced` promise.
 */
export type ExtensionFactory<
	TTableDefinitionMap extends TableDefinitionMap,
	TKvDefinitionMap extends KvDefinitionMap,
	TExports extends ExtensionExports = ExtensionExports,
> = (
	context: ExtensionContext<TTableDefinitionMap, TKvDefinitionMap>,
) => TExports;

/**
 * A map of extension factory functions keyed by extension ID.
 */
export type ExtensionFactoryMap<
	TTableDefinitionMap extends TableDefinitionMap,
	TKvDefinitionMap extends KvDefinitionMap,
> = Record<string, ExtensionFactory<TTableDefinitionMap, TKvDefinitionMap>>;

/**
 * Utility type to infer exports from an extension factory map.
 */
export type InferExtensionExports<TExtensionFactories> = {
	[K in keyof TExtensionFactories]: TExtensionFactories[K] extends ExtensionFactory<
		TableDefinitionMap,
		KvDefinitionMap,
		infer TExports
	>
		? TExports extends ExtensionExports
			? TExports
			: ExtensionExports
		: ExtensionExports;
};

// ─────────────────────────────────────────────────────────────────────────────
// Extension Context Type (flattened)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Context provided to each extension function.
 *
 * This is a flattened view of the workspace doc plus the extension's ID.
 * Extensions can destructure exactly what they need without nesting.
 *
 * @example
 * ```typescript
 * // Destructure only what you need
 * const persistence: ExtensionFactory = ({ ydoc }) => { ... };
 * const sqlite: ExtensionFactory = ({ workspaceId, tables }) => { ... };
 * const markdown: ExtensionFactory = ({ ydoc, tables, workspaceId }) => { ... };
 * ```
 */
export type ExtensionContext<
	TTableDefinitionMap extends TableDefinitionMap,
	TKvDefinitionMap extends KvDefinitionMap,
> = {
	/** The underlying Y.Doc instance. */
	ydoc: Y.Doc;
	/** The workspace ID (without epoch suffix). */
	workspaceId: string;
	/** The epoch number for this workspace doc. */
	epoch: number;
	/** Typed table helpers for CRUD operations. */
	tables: Tables<TTableDefinitionMap>;
	/** Key-value store for simple values. */
	kv: Kv<TKvDefinitionMap>;
	/**
	 * Definition helper for managing table and KV definitions.
	 *
	 * Provides typed CRUD operations for dynamic definition editing (Notion-like UIs).
	 *
	 * @example
	 * ```typescript
	 * // Add a column to a table
	 * definition.tables.table('posts')?.fields.set('dueDate', date());
	 *
	 * // Update table metadata
	 * definition.tables.table('posts')?.metadata.set({ name: 'Blog Posts' });
	 *
	 * // Add a KV setting
	 * definition.kv.set('theme', { name: 'Theme', field: select({ options: ['light', 'dark'] }) });
	 * ```
	 */
	definition: Definition;
	/** This extension's key from `.withExtensions({ key: ... })`. */
	extensionId: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Workspace Doc Creation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a Workspace Y.Doc with typed accessors, extensions, and lifecycle management.
 *
 * This is the primary abstraction for working with workspaces. It combines:
 * - Y.Doc wrapper with typed table and kv helpers
 * - Extension initialization and lifecycle management
 * - Definition merge and observation capabilities
 *
 * Y.Doc ID: `{workspaceId}-{epoch}`
 *
 * ## Structure
 *
 * ```
 * Y.Map('definition')  - Table/KV definitions (rarely changes)
 * Y.Map('kv')          - Settings values (changes occasionally)
 * Y.Map('tables')      - Row data by table name (changes frequently)
 * ```
 *
 * ## Definition Merging
 *
 * After all extensions sync (e.g., persistence loads from disk), the provided
 * `tables` and `kv` definitions are automatically merged into the Y.Doc's definition map.
 * This ensures code-defined definition is the "last writer" over persisted state.
 *
 * For dynamic definition mode (no code-defined definition), pass empty objects `{}` for
 * both `tables` and `kv`.
 *
 * @example
 * ```typescript
 * const workspace = createWorkspaceDoc({
 *   workspaceId: 'blog',
 *   epoch: 0,
 *   tables: { posts: table('posts', { name: 'Posts', fields: [id(), text('title')] }) },
 *   kv: {},
 *   extensionFactories: {
 *     persistence: ({ ydoc }) => persistence({ ydoc }, { filePath: './data.yjs' }),
 *     sqlite: ({ workspaceId, tables }) => sqlite({ workspaceId, tables }, { dbPath: './data.db' }),
 *   },
 * });
 *
 * // Wait for extensions to sync (definition is merged automatically)
 * await workspace.whenSynced;
 *
 * // Use typed table helpers
 * workspace.tables.get('posts').upsert({ id: '1', title: 'Hello' });
 *
 * // Access extension exports
 * workspace.extensions.sqlite.db.select().from(...);
 *
 * // Cleanup
 * await workspace.destroy();
 * ```
 */
export function createWorkspaceDoc<
	TTableDefinitionMap extends TableDefinitionMap,
	TKvDefinitionMap extends KvDefinitionMap,
	TExtensionFactories extends ExtensionFactoryMap<
		TTableDefinitionMap,
		TKvDefinitionMap
	>,
>({
	workspaceId,
	epoch,
	tables: tableDefinitions,
	kv: kvDefinitions,
	extensionFactories,
}: {
	workspaceId: string;
	epoch: number;
	tables: TTableDefinitionMap;
	kv: TKvDefinitionMap;
	extensionFactories: TExtensionFactories;
}): WorkspaceDoc<
	TTableDefinitionMap,
	TKvDefinitionMap,
	InferExtensionExports<TExtensionFactories>
> {
	const docId = `${workspaceId}-${epoch}`;
	// gc: false is required for revision history snapshots to work
	const ydoc = new Y.Doc({ guid: docId, gc: false });

	const definitionMap = ydoc.getMap(
		WORKSPACE_DOC_MAPS.DEFINITION,
	) as DefinitionYMap;

	// Create table and kv helpers bound to the Y.Doc
	// These just bind to Y.Maps - actual data comes from persistence
	const tables = createTables(ydoc, tableDefinitions);
	const kv = createKv(ydoc, kvDefinitions);
	const definition = createDefinition(definitionMap);

	// ─────────────────────────────────────────────────────────────────────────
	// Extension Initialization
	// ─────────────────────────────────────────────────────────────────────────

	// Initialize extensions synchronously — async work is in their whenSynced
	const extensions = {} as InferExtensionExports<TExtensionFactories>;
	for (const [extensionId, extensionFactory] of Object.entries(
		extensionFactories,
	)) {
		// Build flattened context for this extension
		const context: ExtensionContext<TTableDefinitionMap, TKvDefinitionMap> = {
			ydoc,
			workspaceId,
			epoch,
			tables,
			kv,
			definition,
			extensionId,
		};

		// Factory is sync; normalize exports at boundary
		const result = extensionFactory(context);
		const exports = defineExports(result as Record<string, unknown>);
		(extensions as Record<string, unknown>)[extensionId] = exports;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Lifecycle Management
	// ─────────────────────────────────────────────────────────────────────────

	// Aggregate all extension whenSynced promises
	// Fail-fast: any rejection rejects the whole thing (UI shows error state)
	//
	// ORDER OF OPERATIONS (critical for correctness):
	// 1. Wait for all extensions' whenSynced (e.g., persistence finishes loading disk state)
	// 2. THEN merge definition (code-defined definition is "last writer")
	// 3. Resolve whenSynced
	//
	// See: specs/20260119T231252-resilient-client-architecture.md
	const whenSynced = Promise.all(
		Object.values(extensions).map((e) => (e as Lifecycle).whenSynced),
	).then(() => {
		// After persistence has loaded disk state, merge the code-defined definition.
		// This ensures code is "last writer" over any persisted definition.
		// For dynamic definition mode (empty tables/kv), this is a no-op.
		const hasDefinition =
			Object.keys(tableDefinitions).length > 0 ||
			Object.keys(kvDefinitions).length > 0;
		if (hasDefinition) {
			definition.merge({ tables: tableDefinitions, kv: kvDefinitions });
		}
	});

	const destroy = async () => {
		// Use allSettled so one destroy failure doesn't block others
		await Promise.allSettled(
			Object.values(extensions).map((e) => (e as Lifecycle).destroy()),
		);
		// Always release doc resources
		ydoc.destroy();
	};

	return {
		ydoc,
		workspaceId,
		epoch,
		tables,
		kv,
		definition,
		extensions,
		whenSynced,
		destroy,
		[Symbol.asyncDispose]: destroy,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// WorkspaceDoc Type
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The unified workspace abstraction with typed tables, kv, extensions, and lifecycle.
 *
 * This is the return type of `createWorkspaceDoc()` and `createClient()`.
 * It combines Y.Doc wrapper, typed accessors, extension exports, and lifecycle management.
 *
 * @example
 * ```typescript
 * const workspace: WorkspaceDoc<MyTables, MyKv, MyExtensions> = createClient('blog')
 *   .withDefinition(definition)
 *   .withExtensions({ persistence, sqlite });
 *
 * await workspace.whenSynced;
 * workspace.tables.get('posts').upsert({ id: '1', title: 'Hello' });
 * workspace.extensions.sqlite.db.select()...;
 * await workspace.destroy();
 * ```
 */
export type WorkspaceDoc<
	TTableDefinitionMap extends TableDefinitionMap = TableDefinitionMap,
	TKvDefinitionMap extends KvDefinitionMap = KvDefinitionMap,
	TExtensions extends Record<string, ExtensionExports> = Record<
		string,
		ExtensionExports
	>,
> = {
	/** The underlying Y.Doc instance. */
	ydoc: Y.Doc;
	/** The workspace ID (without epoch suffix). */
	workspaceId: string;
	/** The epoch number for this workspace doc. */
	epoch: number;
	/** Typed table helpers for CRUD operations. */
	tables: Tables<TTableDefinitionMap>;
	/** Key-value store for simple values. */
	kv: Kv<TKvDefinitionMap>;
	/** Definition helper for managing table and KV definitions. */
	definition: Definition;
	/** Extension exports keyed by extension ID. */
	extensions: TExtensions;
	/** Promise that resolves when all extensions have synced. */
	whenSynced: Promise<void>;
	/** Clean up all extensions and release Y.Doc resources. */
	destroy(): Promise<void>;
	/** Async disposable for `await using` syntax. */
	[Symbol.asyncDispose]: () => Promise<void>;
};
