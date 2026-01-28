/**
 * CellWorkspace Type Definitions
 *
 * Types for external-schema cell workspace with advisory schema and cell-level CRDT.
 *
 * Key difference from dynamic workspace:
 * - Schema is external (JSON file), not in Y.Doc
 * - Schema is advisory only - no enforcement, just type hints
 * - Simpler structure: cells + rows only (no tables/fields stores in CRDT)
 *
 * @packageDocumentation
 */

import type * as Y from 'yjs';

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
	/** Optional icon (emoji or icon reference) */
	icon?: string | null;
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
	/** Optional icon (emoji or icon reference) */
	icon?: string | null;
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
	/** Optional icon */
	icon?: string | null;
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
	/** Optional icon (emoji or icon reference) */
	icon?: string | null;
	/** Table definitions keyed by table ID */
	tables: Record<string, SchemaTableDefinition>;
	/** Optional KV definitions for single values */
	kv?: Record<string, SchemaKvDefinition>;
};

// ════════════════════════════════════════════════════════════════════════════
// Data Types (Y.Doc)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Cell values can be any JSON-serializable value.
 * The actual type interpretation depends on the schema.
 */
export type CellValue = unknown;

/**
 * Row metadata stored in Y.Doc.
 * The tableId is encoded in the key, not the value.
 */
export type RowMeta = {
	/** Fractional index for ordering within the table */
	order: number;
	/** Tombstone: null = active, timestamp = deleted at that time */
	deletedAt: number | null;
};

// ════════════════════════════════════════════════════════════════════════════
// Change Events
// ════════════════════════════════════════════════════════════════════════════

/**
 * A single change event for cells or rows.
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
 * Store for row metadata.
 */
export type RowsStore = {
	/** Get row metadata by table and row ID */
	get(tableId: string, rowId: string): RowMeta | undefined;
	/** Set row metadata (creates or updates) */
	set(tableId: string, rowId: string, meta: RowMeta): void;
	/** Soft-delete a row (sets deletedAt) */
	delete(tableId: string, rowId: string): void;
	/** Check if a row exists (including soft-deleted) */
	has(tableId: string, rowId: string): boolean;

	/** Get all rows for a table, sorted by order (includes soft-deleted) */
	getByTable(tableId: string): Array<{ id: string; meta: RowMeta }>;
	/** Get active rows for a table, sorted by order (excludes soft-deleted) */
	getActiveByTable(tableId: string): Array<{ id: string; meta: RowMeta }>;

	// Convenience methods
	/** Create a new row (generates ID if not provided, auto-assigns order) */
	create(tableId: string, rowId?: string, order?: number): string;
	/** Reorder a row (set new order value) */
	reorder(tableId: string, rowId: string, newOrder: number): void;
	/** Restore a soft-deleted row */
	restore(tableId: string, rowId: string): void;

	/** Observe changes to rows */
	observe(handler: ChangeHandler<RowMeta>): () => void;
};

/**
 * Store for cell values.
 */
export type CellsStore = {
	/** Get a cell value */
	get(tableId: string, rowId: string, fieldId: string): CellValue | undefined;
	/** Set a cell value */
	set(tableId: string, rowId: string, fieldId: string, value: CellValue): void;
	/** Delete a cell value (hard delete) */
	delete(tableId: string, rowId: string, fieldId: string): void;
	/** Check if a cell exists */
	has(tableId: string, rowId: string, fieldId: string): boolean;

	/**
	 * Get all cells for a row by scanning with prefix.
	 * Returns a map from fieldId to cell value.
	 */
	getByRow(tableId: string, rowId: string): Map<string, CellValue>;

	/**
	 * Get cells for a row for specific fields (direct lookups).
	 * More efficient when you know the field IDs.
	 */
	getByRowFields(
		tableId: string,
		rowId: string,
		fieldIds: string[],
	): Map<string, CellValue>;

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
// Helper Types
// ════════════════════════════════════════════════════════════════════════════

/**
 * A row with its cell values, ready for rendering.
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
// Workspace Client
// ════════════════════════════════════════════════════════════════════════════

/**
 * The main cell workspace client.
 *
 * Provides access to raw CRDT stores without schema enforcement.
 * Schema is applied externally as a "lens" for viewing/editing.
 */
export type CellWorkspaceClient = {
	/** Workspace identifier */
	readonly id: string;
	/** The underlying Yjs document */
	readonly ydoc: Y.Doc;

	// Low-level store access
	/** Row metadata store */
	readonly rows: RowsStore;
	/** Cell values store */
	readonly cells: CellsStore;
	/** KV store for workspace-level values */
	readonly kv: KvStore;

	// Helper methods
	/**
	 * Get all active rows for a table with their cell values.
	 */
	getRowsWithCells(tableId: string): RowWithCells[];

	/**
	 * Get rows with typed cells validated against schema.
	 * Schema is advisory - data that doesn't match is flagged, not rejected.
	 */
	getTypedRowsWithCells(
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
