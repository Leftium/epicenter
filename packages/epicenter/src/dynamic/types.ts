/**
 * Dynamic Workspace Type Definitions
 *
 * Types for runtime-editable, Notion-like databases with cell-level CRDT granularity.
 *
 * @packageDocumentation
 */

import type * as Y from 'yjs';

// ════════════════════════════════════════════════════════════════════════════
// Field Types
// ════════════════════════════════════════════════════════════════════════════

/**
 * Supported field types for dynamic tables.
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
	| 'json';

// ════════════════════════════════════════════════════════════════════════════
// Schema Definitions
// ════════════════════════════════════════════════════════════════════════════

/**
 * Definition of a field within a table.
 *
 * Order is stored directly on the field (not on the table) to eliminate
 * orphaning risk during concurrent modifications.
 */
export type FieldDefinition = {
	/** Display name of the field */
	name: string;
	/** Data type of the field */
	type: FieldType;
	/** Fractional index for ordering (supports insertion via fractional values) */
	order: number;
	/** Tombstone: null = active, timestamp = deleted at that time */
	deletedAt: number | null;
	/** Optional icon (emoji or icon reference) */
	icon?: string | null;
	/** Options for select/tags field types */
	options?: string[];
	/** Default value for new cells */
	default?: unknown;
};

/**
 * Definition of a table.
 *
 * Note: Field order is NOT stored here - it's derived from field definitions.
 */
export type TableDefinition = {
	/** Display name of the table */
	name: string;
	/** Tombstone: null = active, timestamp = deleted at that time */
	deletedAt: number | null;
	/** Optional icon (emoji or icon reference) */
	icon?: string | null;
};

/**
 * Metadata for a row.
 *
 * Note: tableId is encoded in the key, not the value.
 */
export type RowMeta = {
	/** Fractional index for ordering within the table */
	order: number;
	/** Tombstone: null = active, timestamp = deleted at that time */
	deletedAt: number | null;
};

/**
 * Cell values can be any JSON-serializable value.
 * The actual type depends on the field type.
 */
export type CellValue = unknown;

// ════════════════════════════════════════════════════════════════════════════
// Change Events
// ════════════════════════════════════════════════════════════════════════════

/**
 * A single change event for any store.
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
 * Store for table definitions.
 */
export type TablesStore = {
	/** Get a table by ID */
	get(tableId: string): TableDefinition | undefined;
	/** Set a table definition (creates or updates) */
	set(tableId: string, table: TableDefinition): void;
	/** Soft-delete a table (sets deletedAt) */
	delete(tableId: string): void;
	/** Check if a table exists (including soft-deleted) */
	has(tableId: string): boolean;
	/** Get all tables (including soft-deleted) */
	getAll(): Map<string, TableDefinition>;
	/** Get all active tables (not soft-deleted) */
	getActive(): Map<string, TableDefinition>;

	// Convenience methods
	/** Create a new table */
	create(tableId: string, options: { name: string; icon?: string | null }): void;
	/** Rename a table */
	rename(tableId: string, newName: string): void;
	/** Restore a soft-deleted table */
	restore(tableId: string): void;

	/** Observe changes to tables */
	observe(handler: ChangeHandler<TableDefinition>): () => void;
};

/**
 * Store for field definitions.
 */
export type FieldsStore = {
	/** Get a field by table and field ID */
	get(tableId: string, fieldId: string): FieldDefinition | undefined;
	/** Set a field definition (creates or updates) */
	set(tableId: string, fieldId: string, field: FieldDefinition): void;
	/** Soft-delete a field (sets deletedAt) */
	delete(tableId: string, fieldId: string): void;
	/** Check if a field exists (including soft-deleted) */
	has(tableId: string, fieldId: string): boolean;

	/** Get all fields for a table, sorted by order (includes soft-deleted) */
	getByTable(tableId: string): Array<{ id: string; field: FieldDefinition }>;
	/** Get active fields for a table, sorted by order (excludes soft-deleted) */
	getActiveByTable(tableId: string): Array<{ id: string; field: FieldDefinition }>;

	// Convenience methods
	/** Create a new field (auto-assigns order if not specified) */
	create(
		tableId: string,
		fieldId: string,
		options: {
			name: string;
			type: FieldType;
			order?: number;
			icon?: string | null;
			options?: string[];
			default?: unknown;
		},
	): void;
	/** Rename a field */
	rename(tableId: string, fieldId: string, newName: string): void;
	/** Reorder a field (set new order value) */
	reorder(tableId: string, fieldId: string, newOrder: number): void;
	/** Restore a soft-deleted field */
	restore(tableId: string, fieldId: string): void;

	/** Observe changes to fields */
	observe(handler: ChangeHandler<FieldDefinition>): () => void;
};

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
	/** Create a new row (generates ID if not provided, auto-assigns order if not specified) */
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
 *
 * Cells do NOT have tombstones - they are filtered out based on
 * their field's or row's deletedAt status.
 */
export type CellsStore = {
	/** Get a cell value */
	get(tableId: string, rowId: string, fieldId: string): CellValue | undefined;
	/** Set a cell value */
	set(tableId: string, rowId: string, fieldId: string, value: CellValue): void;
	/** Delete a cell value (hard delete, not tombstone) */
	delete(tableId: string, rowId: string, fieldId: string): void;
	/** Check if a cell exists */
	has(tableId: string, rowId: string, fieldId: string): boolean;

	/**
	 * Get all cells for a row using direct lookups (not prefix scan).
	 * Returns a map from fieldId to cell value.
	 */
	getByRow(
		tableId: string,
		rowId: string,
		fieldIds: string[],
	): Map<string, CellValue>;

	/** Observe changes to cells */
	observe(handler: ChangeHandler<CellValue>): () => void;
};

// ════════════════════════════════════════════════════════════════════════════
// High-Level Helper Types
// ════════════════════════════════════════════════════════════════════════════

/**
 * A table with its field definitions, ready for rendering.
 */
export type TableWithFields = {
	id: string;
	name: string;
	icon: string | null;
	deletedAt: number | null;
	fields: Array<{
		id: string;
		name: string;
		type: FieldType;
		order: number;
		icon: string | null;
		options?: string[];
		default?: unknown;
	}>;
};

/**
 * A row with its cell values, ready for rendering.
 */
export type RowWithCells = {
	id: string;
	order: number;
	deletedAt: number | null;
	cells: Record<string, CellValue>;
};

// ════════════════════════════════════════════════════════════════════════════
// Workspace Client
// ════════════════════════════════════════════════════════════════════════════

/**
 * The main dynamic workspace client.
 *
 * Provides access to all stores and high-level helper methods.
 */
export type DynamicWorkspaceClient = {
	/** Workspace identifier */
	readonly id: string;
	/** The underlying Yjs document */
	readonly ydoc: Y.Doc;

	// Low-level store access
	/** Table definitions store */
	readonly tables: TablesStore;
	/** Field definitions store */
	readonly fields: FieldsStore;
	/** Row metadata store */
	readonly rows: RowsStore;
	/** Cell values store */
	readonly cells: CellsStore;

	// High-level helpers
	/**
	 * Get a table with all its active field definitions.
	 * Returns null if the table doesn't exist or is deleted.
	 */
	getTableWithFields(tableId: string): TableWithFields | null;

	/**
	 * Get all active rows for a table with their cell values.
	 * Only includes cells for active fields.
	 */
	getRowsWithCells(tableId: string): RowWithCells[];

	/**
	 * Batch multiple writes into a single Yjs transaction.
	 * Observers receive all changes in one callback.
	 */
	batch<T>(fn: (ws: DynamicWorkspaceClient) => T): T;

	// Lifecycle
	/**
	 * Destroy the workspace client and release resources.
	 */
	destroy(): Promise<void>;
};

// ════════════════════════════════════════════════════════════════════════════
// Factory Options
// ════════════════════════════════════════════════════════════════════════════

/**
 * Options for creating a dynamic workspace.
 */
export type CreateDynamicWorkspaceOptions = {
	/** Unique identifier for the workspace (used as Y.Doc guid) */
	id: string;
	/** Optional existing Y.Doc to use instead of creating a new one */
	ydoc?: Y.Doc;
};
