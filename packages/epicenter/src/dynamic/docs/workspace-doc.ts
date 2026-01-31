import * as Y from 'yjs';
import { defineExports, type Lifecycle } from '../../core/lifecycle';
import type {
	KvField,
	KvValue,
	TableDefinition,
} from '../../core/schema/fields/types';
import { createKv, type Kv } from '../kv/core';
import { createTables, type Tables } from '../tables/create-tables';

// ─────────────────────────────────────────────────────────────────────────────
// Y.Doc Top-Level Map Names
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The two top-level Y.Map names in a Workspace Y.Doc.
 *
 * Each workspace epoch has a single Y.Doc with two top-level maps:
 * - `kv`: Settings values (actual KV data)
 * - `tables`: Table data (rows organized by table name)
 *
 * Note: Definitions (table/KV schemas) are stored in static JSON files,
 * NOT in Y.Doc. This keeps Y.Docs lean and focused on data only.
 *
 * Note: Workspace-level identity (name, icon, description) lives in the
 * Head Doc, NOT here. This ensures renaming applies to all epochs.
 *
 * This 1:1 mapping enables independent observation and different persistence
 * strategies per map.
 */
export const WORKSPACE_DOC_MAPS = {
	/** Settings values. Changes occasionally. Persisted to kv.json */
	KV: 'kv',
	/** Table row data. Changes frequently. Persisted to tables.sqlite */
	TABLES: 'tables',
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Y.Map Type Aliases
// ─────────────────────────────────────────────────────────────────────────────

/** Y.Map storing cell values for a single row, keyed by column name. */
export type RowYMap = Y.Map<unknown>;

/** Y.Map storing rows for a single table, keyed by row ID. */
export type TableYMap = Y.Map<RowYMap>;

/** Y.Map storing all tables, keyed by table name. */
export type TablesYMap = Y.Map<TableYMap>;

/** Y.Array storing KV values as LWW entries (key, val, ts). */
export type KvYArray = Y.Array<{ key: string; val: KvValue; ts: number }>;

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
	TTableDefinitions extends readonly TableDefinition[],
	TKvFields extends readonly KvField[],
	TExports extends ExtensionExports = ExtensionExports,
> = (context: ExtensionContext<TTableDefinitions, TKvFields>) => TExports;

/**
 * A map of extension factory functions keyed by extension ID.
 */
export type ExtensionFactoryMap<
	TTableDefinitions extends readonly TableDefinition[],
	TKvFields extends readonly KvField[],
> = Record<string, ExtensionFactory<TTableDefinitions, TKvFields>>;

/**
 * Utility type to infer exports from an extension factory map.
 */
export type InferExtensionExports<TExtensionFactories> = {
	[K in keyof TExtensionFactories]: TExtensionFactories[K] extends ExtensionFactory<
		readonly TableDefinition[],
		readonly KvField[],
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
	TTableDefinitions extends readonly TableDefinition[],
	TKvFields extends readonly KvField[],
> = {
	/** The underlying Y.Doc instance. */
	ydoc: Y.Doc;
	/** The workspace ID (without epoch suffix). */
	workspaceId: string;
	/** The epoch number for this workspace doc. */
	epoch: number;
	/** Typed table helpers for CRUD operations. */
	tables: Tables<TTableDefinitions>;
	/** Key-value store for simple values. */
	kv: Kv<TKvFields>;
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
 *
 * Y.Doc ID: `{workspaceId}-{epoch}`
 *
 * ## Structure
 *
 * ```
 * Y.Map('kv')          - Settings values (changes occasionally)
 * Y.Map('tables')      - Row data by table name (changes frequently)
 * ```
 *
 * Note: Definitions (table/KV schemas) are stored in static JSON files,
 * NOT in Y.Doc. This keeps Y.Docs lean and focused on data only.
 *
 * @example
 * ```typescript
 * const workspace = createWorkspaceDoc({
 *   workspaceId: 'blog',
 *   epoch: 0,
 *   tables: { posts: table({ id: 'posts', name: 'Posts', fields: [id(), text({ id: 'title' })] }) },
 *   kv: {},
 *   extensionFactories: {
 *     persistence: ({ ydoc }) => persistence({ ydoc }, { filePath: './data.yjs' }),
 *     sqlite: ({ workspaceId, tables }) => sqlite({ workspaceId, tables }, { dbPath: './data.db' }),
 *   },
 * });
 *
 * // Wait for extensions to sync
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
	TTableDefinitions extends readonly TableDefinition[],
	TKvFields extends readonly KvField[],
	TExtensionFactories extends ExtensionFactoryMap<TTableDefinitions, TKvFields>,
>({
	workspaceId,
	epoch,
	tables: tableDefinitions,
	kv: kvDefinitions,
	extensionFactories,
}: {
	workspaceId: string;
	epoch: number;
	tables: TTableDefinitions;
	kv: TKvFields;
	extensionFactories: TExtensionFactories;
}): WorkspaceDoc<
	TTableDefinitions,
	TKvFields,
	InferExtensionExports<TExtensionFactories>
> {
	const docId = `${workspaceId}-${epoch}`;
	// gc: false is required for revision history snapshots to work
	const ydoc = new Y.Doc({ guid: docId, gc: false });

	// Create table and kv helpers bound to the Y.Doc
	// These just bind to Y.Maps - actual data comes from persistence
	const tables = createTables(ydoc, tableDefinitions);
	const kv = createKv(ydoc, kvDefinitions);

	// ─────────────────────────────────────────────────────────────────────────
	// Extension Initialization
	// ─────────────────────────────────────────────────────────────────────────

	// Initialize extensions synchronously — async work is in their whenSynced
	const extensions = {} as InferExtensionExports<TExtensionFactories>;
	for (const [extensionId, extensionFactory] of Object.entries(
		extensionFactories,
	)) {
		// Build flattened context for this extension
		const context: ExtensionContext<TTableDefinitions, TKvFields> = {
			ydoc,
			workspaceId,
			epoch,
			tables,
			kv,
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
	// See: specs/20260119T231252-resilient-client-architecture.md
	const whenSynced = Promise.all(
		Object.values(extensions).map((e) => (e as Lifecycle).whenSynced),
	).then(() => {
		// All extensions synced - workspace is ready
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
 * This is the return type of `createWorkspaceDoc()`. For dynamic workspaces,
 * use `createWorkspace()` from `@epicenter/hq/dynamic`.
 *
 * @example
 * ```typescript
 * import { createWorkspace } from '@epicenter/hq/dynamic';
 *
 * const workspace = createWorkspace({
 *   id: 'blog',
 *   headDoc,
 *   definition: { name: 'Blog', tables: [...] },
 * }).withExtensions({ persistence, sqlite });
 *
 * await workspace.whenSynced;
 * workspace.table('posts').setCell('row1', 'title', 'Hello');
 * workspace.extensions.sqlite.db.select()...;
 * await workspace.destroy();
 * ```
 */
export type WorkspaceDoc<
	TTableDefinitions extends
		readonly TableDefinition[] = readonly TableDefinition[],
	TKvFields extends readonly KvField[] = readonly KvField[],
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
	tables: Tables<TTableDefinitions>;
	/** Key-value store for simple values. */
	kv: Kv<TKvFields>;
	/** Extension exports keyed by extension ID. */
	extensions: TExtensions;
	/** Promise that resolves when all extensions have synced. */
	whenSynced: Promise<void>;
	/** Clean up all extensions and release Y.Doc resources. */
	destroy(): Promise<void>;
	/** Async disposable for `await using` syntax. */
	[Symbol.asyncDispose]: () => Promise<void>;
};
