/**
 * CellWorkspace Type Definitions
 *
 * Types for external-schema cell workspace with advisory schema and cell-level CRDT.
 *
 * Architecture (Option B):
 * - One Y.Array per table, accessed via `ydoc.getArray(tableId)`
 * - Every entry is a cell value
 * - Schema is external (JSON file), not in Y.Doc
 * - Schema is advisory only - no enforcement, just type hints
 *
 * @packageDocumentation
 */

import type * as Y from 'yjs';
import type { Icon } from '../core/schema/fields/types';
import type {
	GetCellResult,
	GetResult,
	InvalidRowResult,
	RowResult,
} from './validation-types';

// ════════════════════════════════════════════════════════════════════════════
// Schema Types (External JSON)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Supported field types for schema definitions.
 */
export type FieldType =
	| 'text'
	| 'integer'
	| 'real'
	| 'boolean'
	| 'date'
	| 'datetime'
	| 'select'
	| 'tags'
	| 'json'
	| 'richtext';

/**
 * Field definition in external schema.
 * Purely advisory - describes how to interpret cell values.
 */
export type SchemaFieldDefinition = {
	/** Display name of the field */
	name: string;
	/** Data type hint for the field */
	type: FieldType;
	/** Display order (lower = first) */
	order: number;
	/** Optional icon - tagged string format 'type:value' or plain emoji */
	icon?: Icon | string | null;
	/** Options for select/tags field types */
	options?: string[];
	/** Default value for new cells */
	default?: unknown;
};

/**
 * Table definition in external schema.
 */
export type SchemaTableDefinition = {
	/** Display name of the table */
	name: string;
	/** Optional icon - tagged string format 'type:value' or plain emoji */
	icon?: Icon | string | null;
	/** Field definitions keyed by field ID */
	fields: Record<string, SchemaFieldDefinition>;
};

/**
 * KV field definition in external schema.
 */
export type SchemaKvDefinition = {
	/** Display name of the KV field */
	name: string;
	/** Data type hint */
	type: FieldType;
	/** Optional icon - tagged string format 'type:value' or plain emoji */
	icon?: Icon | string | null;
	/** Options for select field type */
	options?: string[];
	/** Default value */
	default?: unknown;
};

/**
 * Complete workspace definition (can be stored as external JSON file).
 *
 * This is the "lens" through which you view the data.
 * The data itself doesn't need to comply with this schema.
 */
export type WorkspaceDefinition = {
	/** Display name of the workspace */
	name: string;
	/** Optional description of the workspace */
	description?: string;
	/** Optional icon - tagged string format 'type:value' or plain emoji */
	icon?: Icon | string | null;
	/** Table definitions keyed by table ID */
	tables: Record<string, SchemaTableDefinition>;
	/** Optional KV definitions for single values */
	kv?: Record<string, SchemaKvDefinition>;
};

// ════════════════════════════════════════════════════════════════════════════
// Data Types
// ════════════════════════════════════════════════════════════════════════════

/**
 * Cell values can be any JSON-serializable value.
 * The actual type interpretation depends on the schema.
 */
export type CellValue = unknown;

/**
 * A row with all its cell values.
 */
export type RowData = {
	/** Row identifier */
	id: string;
	/** All cells for this row */
	cells: Record<string, CellValue>;
};

/**
 * Typed cell with validation status.
 */
export type TypedCell = {
	value: CellValue;
	type: FieldType;
	valid: boolean;
};

/**
 * A row with typed cells (includes validation against schema).
 */
export type TypedRowWithCells = {
	id: string;
	cells: Record<string, TypedCell>;
	/** Fields in schema but not in data */
	missingFields: string[];
	/** Fields in data but not in schema */
	extraFields: string[];
};

// ════════════════════════════════════════════════════════════════════════════
// Change Events
// ════════════════════════════════════════════════════════════════════════════

/**
 * A single change event for cells.
 */
export type ChangeEvent<T> =
	| { type: 'add'; key: string; value: T }
	| { type: 'update'; key: string; value: T; previousValue: T }
	| { type: 'delete'; key: string; previousValue: T };

/**
 * Handler for change events.
 */
export type ChangeHandler<T> = (
	changes: ChangeEvent<T>[],
	transaction: Y.Transaction,
) => void;

// ════════════════════════════════════════════════════════════════════════════
// Store Interfaces
// ════════════════════════════════════════════════════════════════════════════

/**
 * Store for a single table's data with integrated validation.
 *
 * All methods return validated results that include both the value and validation status.
 * Even invalid results include the raw value via `.value` or `.row`, so there's no need
 * for separate "raw" access - you can always get the data regardless of validity.
 */
export type TableStore = {
	/** The table identifier */
	tableId: string;
	/** The schema definition for this table (empty fields for dynamic tables) */
	schema: SchemaTableDefinition;

	// Cell operations (validated)
	/** Get a validated cell value */
	get(rowId: string, fieldId: string): GetCellResult<unknown>;
	/** Set a cell value (writes bypass validation - advisory schema) */
	set(rowId: string, fieldId: string, value: CellValue): void;
	/** Delete a cell value (hard delete) */
	delete(rowId: string, fieldId: string): void;
	/** Check if a cell exists */
	has(rowId: string, fieldId: string): boolean;

	// Row operations (validated)
	/** Get a validated row */
	getRow(rowId: string): GetResult<RowData>;
	/** Generate a row ID (or validate a custom one) */
	createRow(rowId?: string): string;
	/** Delete a row (hard delete - removes all cells) */
	deleteRow(rowId: string): void;

	// Bulk operations (validated)
	/** Get all rows with validation results */
	getAll(): RowResult<RowData>[];
	/** Get all valid rows (filters out invalid ones) */
	getAllValid(): RowData[];
	/** Get all invalid rows with error details */
	getAllInvalid(): InvalidRowResult[];
	/** Get all row IDs */
	getRowIds(): string[];

	// Observation
	/** Observe changes to cells */
	observe(handler: ChangeHandler<CellValue>): () => void;
};

/**
 * Store for workspace-level key-value pairs.
 */
export type KvStore = {
	/** Get a value by key */
	get(key: string): unknown | undefined;
	/** Set a value */
	set(key: string, value: unknown): void;
	/** Delete a value (hard delete) */
	delete(key: string): void;
	/** Check if a key exists */
	has(key: string): boolean;
	/** Get all key-value pairs */
	getAll(): Map<string, unknown>;

	/** Observe changes */
	observe(handler: ChangeHandler<unknown>): () => void;
};

// ════════════════════════════════════════════════════════════════════════════
// Workspace Client
// ════════════════════════════════════════════════════════════════════════════

/**
 * The main cell workspace client.
 *
 * Provides access to table stores and KV store.
 * Schema is applied as a "lens" for viewing/editing.
 */
export type CellWorkspaceClient<
	TTableDefs extends Record<string, SchemaTableDefinition> = Record<
		string,
		SchemaTableDefinition
	>,
	TExtensions = {},
> = {
	/** Workspace identifier (no epoch suffix) */
	id: string;
	/** Current epoch number (0 if not using HeadDoc) */
	epoch: number;
	/** The underlying Yjs document */
	ydoc: Y.Doc;

	// Workspace metadata (from definition)
	/** Display name of the workspace */
	name: string;
	/** Description of the workspace */
	description: string;
	/** Icon for the workspace */
	icon: Icon | string | null;
	/** The full workspace definition */
	definition: WorkspaceDefinition & { tables: TTableDefs };

	/**
	 * Get a table store. Creates the underlying Y.Array if it doesn't exist.
	 * Table stores are cached - calling with same tableId returns same instance.
	 */
	table<K extends keyof TTableDefs>(tableId: K): TableStore;
	table(tableId: string): TableStore;

	/** KV store for workspace-level values */
	kv: KvStore;

	/** Extension exports (empty object if no extensions) */
	extensions: TExtensions;

	// Convenience methods with schema

	/**
	 * Get rows with typed cells validated against schema.
	 * Uses the table schema from the definition.
	 * Schema is advisory - data that doesn't match is flagged, not rejected.
	 */
	getTypedRows(tableId: string): TypedRowWithCells[];

	/**
	 * Batch multiple writes into a single Yjs transaction.
	 */
	batch<T>(
		fn: (ws: CellWorkspaceClient<TTableDefs, TExtensions>) => T,
	): T;

	/**
	 * Resolves when all extensions are synced/ready.
	 */
	whenSynced: Promise<void>;

	/**
	 * Destroy the workspace client and release resources.
	 */
	destroy(): Promise<void>;
};

// ════════════════════════════════════════════════════════════════════════════
// Factory Options
// ════════════════════════════════════════════════════════════════════════════

/**
 * Options for creating a cell workspace.
 */
export type CreateCellWorkspaceOptions = {
	/** Unique identifier for the workspace (used as Y.Doc guid) */
	id: string;
	/** Workspace definition (schema for tables and KV) */
	definition: WorkspaceDefinition;
	/** Optional existing Y.Doc to use instead of creating a new one */
	ydoc?: Y.Doc;
};

// ════════════════════════════════════════════════════════════════════════════
// HeadDoc-Based Options (New API)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Options for creating a cell workspace with HeadDoc.
 *
 * This is the new preferred API that integrates with the HeadDoc epoch system.
 * The Y.Doc guid will be `{workspaceId}-{epoch}` for time-travel support.
 */
export type CreateCellWorkspaceWithHeadDocOptions<
	TTableDefs extends Record<string, SchemaTableDefinition>,
> = {
	/** HeadDoc containing workspace identity and epoch state */
	headDoc: {
		workspaceId: string;
		getEpoch(): number;
	};
	/** Workspace definition (schema for tables and KV) */
	definition: WorkspaceDefinition & { tables: TTableDefs };
};
