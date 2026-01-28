/**
 * CellWorkspace Type Definitions
 *
 * Types for external-schema cell workspace with advisory schema and cell-level CRDT.
 *
 * Architecture (Option B):
 * - One Y.Array per table, accessed via `ydoc.getArray(tableId)`
 * - Every entry is a cell value (including row metadata as reserved fields)
 * - Schema is external (JSON file), not in Y.Doc
 * - Schema is advisory only - no enforcement, just type hints
 *
 * @packageDocumentation
 */

import type * as Y from 'yjs';
import type { Icon } from '../core/schema/fields/types';

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
 * Complete workspace schema (stored in external JSON file).
 *
 * This is the "lens" through which you view the data.
 * The data itself doesn't need to comply with this schema.
 */
export type WorkspaceSchema = {
	/** Display name of the workspace */
	name: string;
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
 * A row with all its cell values (including metadata fields).
 */
export type RowData = {
	/** Row identifier */
	id: string;
	/** All cells including _order and _deletedAt */
	cells: Record<string, CellValue>;
};

/**
 * A row with cells separated from metadata.
 */
export type RowWithCells = {
	id: string;
	order: number;
	deletedAt: number | null;
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
	order: number;
	deletedAt: number | null;
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
 * Store for a single table's data.
 * Every entry is a cell, including row metadata.
 */
export type TableStore = {
	/** The table identifier */
	readonly tableId: string;

	// Cell operations
	/** Get a cell value */
	get(rowId: string, fieldId: string): CellValue | undefined;
	/** Set a cell value */
	set(rowId: string, fieldId: string, value: CellValue): void;
	/** Delete a cell value (hard delete) */
	delete(rowId: string, fieldId: string): void;
	/** Check if a cell exists */
	has(rowId: string, fieldId: string): boolean;

	// Row operations
	/** Get all cells for a row (including metadata) */
	getRow(rowId: string): Record<string, CellValue> | undefined;
	/** Create a new row (sets _order and _deletedAt) */
	createRow(rowId?: string, order?: number): string;
	/** Soft-delete a row (sets _deletedAt) */
	deleteRow(rowId: string): void;
	/** Restore a soft-deleted row */
	restoreRow(rowId: string): void;
	/** Change a row's order */
	reorderRow(rowId: string, newOrder: number): void;

	// Bulk operations
	/** Get all rows including deleted, with metadata in cells */
	getAllRows(): RowData[];
	/** Get active rows only, with metadata in cells */
	getRows(): RowData[];
	/** Get active rows with metadata separated from cells */
	getRowsWithoutMeta(): RowWithCells[];

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
 * Schema is applied externally as a "lens" for viewing/editing.
 */
export type CellWorkspaceClient = {
	/** Workspace identifier */
	readonly id: string;
	/** The underlying Yjs document */
	readonly ydoc: Y.Doc;

	/**
	 * Get a table store. Creates the underlying Y.Array if it doesn't exist.
	 * Table stores are cached - calling with same tableId returns same instance.
	 */
	table(tableId: string): TableStore;

	/** KV store for workspace-level values */
	readonly kv: KvStore;

	// Convenience methods with schema

	/**
	 * Get rows with typed cells validated against schema.
	 * Schema is advisory - data that doesn't match is flagged, not rejected.
	 */
	getTypedRows(
		tableId: string,
		tableSchema: SchemaTableDefinition,
	): TypedRowWithCells[];

	/**
	 * Batch multiple writes into a single Yjs transaction.
	 */
	batch<T>(fn: (ws: CellWorkspaceClient) => T): T;

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
	/** Optional existing Y.Doc to use instead of creating a new one */
	ydoc?: Y.Doc;
};
