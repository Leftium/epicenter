/**
 * Grid Workspace Type Definitions
 *
 * Types for the unified Grid Workspace API with optional HeadDoc support.
 *
 * Architecture:
 * - Cell-level CRDT storage (one Y.Array per table)
 * - External schema with validation (definition passed in)
 * - Optional HeadDoc for time travel and epochs
 *
 * @packageDocumentation
 */

import type { TLocalizedValidationError } from 'typebox/error';
import type * as Y from 'yjs';
import type {
	FieldType as CoreFieldType,
	Field,
	Icon,
	KvField,
	TableDefinition,
} from '../core/schema/fields/types';
import type { WorkspaceDefinition as CoreWorkspaceDefinition } from '../core/workspace/workspace';

// ════════════════════════════════════════════════════════════════════════════
// Schema Types (Re-exported from Core)
// ════════════════════════════════════════════════════════════════════════════

/** Field definition - re-exported from core. */
export type GridFieldDefinition = Field;

/** Table definition - re-exported from core. */
export type GridTableDefinition = TableDefinition<readonly Field[]>;

/** KV definition - re-exported from core. */
export type GridKvDefinition = KvField;

/** Complete workspace definition - re-exported from core. */
export type GridWorkspaceDefinition = CoreWorkspaceDefinition;

/** Field type discriminator. */
export type FieldType = CoreFieldType;

// ════════════════════════════════════════════════════════════════════════════
// HeadDoc Interface
// ════════════════════════════════════════════════════════════════════════════

/**
 * Minimal HeadDoc interface required by Grid Workspace.
 *
 * This allows any object with these methods to be used as a HeadDoc,
 * enabling flexibility in how HeadDoc is created/managed.
 */
export type GridHeadDoc = {
	/** The workspace ID (no epoch suffix) */
	workspaceId: string;
	/** Get the current epoch number */
	getEpoch(): number;
};

// ════════════════════════════════════════════════════════════════════════════
// Data Types
// ════════════════════════════════════════════════════════════════════════════

/** Cell values can be any JSON-serializable value. */
export type CellValue = unknown;

/** A row with all its cell values. */
export type RowData = {
	/** Row identifier */
	id: string;
	/** All cells for this row */
	cells: Record<string, CellValue>;
};

/** Typed cell with validation status. */
export type TypedCell = {
	value: CellValue;
	type: FieldType;
	valid: boolean;
};

/** A row with typed cells (includes validation against schema). */
export type TypedRowWithCells = {
	id: string;
	cells: Record<string, TypedCell>;
	/** Fields in schema but not in data */
	missingFields: string[];
	/** Fields in data but not in schema */
	extraFields: string[];
};

// ════════════════════════════════════════════════════════════════════════════
// Validation Types
// ════════════════════════════════════════════════════════════════════════════

/**
 * A single validation error from TypeBox schema validation.
 *
 * Contains detailed information about why a row field failed validation,
 * including the JSON path to the invalid field, the expected schema,
 * and a human-readable error message.
 */
export type ValidationError = TLocalizedValidationError;

/** A cell that passed validation. */
export type ValidCellResult<TValue> = {
	status: 'valid';
	value: TValue;
};

/** A cell that exists but failed validation. */
export type InvalidCellResult = {
	status: 'invalid';
	key: string;
	errors: ValidationError[];
	value: unknown;
};

/** A cell that was not found. */
export type NotFoundCellResult = {
	status: 'not_found';
	key: string;
	value: undefined;
};

/** Result of getting a single cell. */
export type GetCellResult<TValue> =
	| ValidCellResult<TValue>
	| InvalidCellResult
	| NotFoundCellResult;

/** A row that passed validation. */
export type ValidRowResult<TRow> = {
	status: 'valid';
	row: TRow;
};

/** A row that exists but failed validation. */
export type InvalidRowResult = {
	status: 'invalid';
	id: string;
	tableName?: string;
	errors: ValidationError[];
	row: Record<string, CellValue>;
};

/** A row that was not found. */
export type NotFoundRowResult = {
	status: 'not_found';
	id: string;
	row: undefined;
};

/** Result of getting a single row. */
export type GetResult<TRow> =
	| ValidRowResult<TRow>
	| InvalidRowResult
	| NotFoundRowResult;

/** Result of validating a row (exists, may be valid or invalid). */
export type RowResult<TRow> = ValidRowResult<TRow> | InvalidRowResult;

// ════════════════════════════════════════════════════════════════════════════
// Change Events
// ════════════════════════════════════════════════════════════════════════════

/** A single change event for cells. */
export type ChangeEvent<T> =
	| { type: 'add'; key: string; value: T }
	| { type: 'update'; key: string; value: T; previousValue: T }
	| { type: 'delete'; key: string; previousValue: T };

/** Handler for change events. */
export type ChangeHandler<T> = (
	changes: ChangeEvent<T>[],
	transaction: Y.Transaction,
) => void;

// ════════════════════════════════════════════════════════════════════════════
// Grid Table Helper
// ════════════════════════════════════════════════════════════════════════════

/**
 * Helper for a single table's data with integrated validation.
 *
 * All methods return validated results that include both the value and validation status.
 */
export type GridTableHelper = {
	/** The table identifier */
	tableId: string;
	/** The schema definition for this table */
	schema: GridTableDefinition;

	// ═══════════════════════════════════════════════════════════════
	// CELL OPERATIONS (validated)
	// ═══════════════════════════════════════════════════════════════

	/** Get a validated cell value */
	getCell(rowId: string, fieldId: string): GetCellResult<unknown>;
	/** Set a cell value */
	setCell(rowId: string, fieldId: string, value: CellValue): void;
	/** Delete a cell value (hard delete) */
	deleteCell(rowId: string, fieldId: string): void;
	/** Check if a cell exists */
	hasCell(rowId: string, fieldId: string): boolean;

	// ═══════════════════════════════════════════════════════════════
	// ROW OPERATIONS (validated)
	// ═══════════════════════════════════════════════════════════════

	/** Get a validated row */
	getRow(rowId: string): GetResult<RowData>;

	/**
	 * Create a new row.
	 * @param rowId - Optional custom row ID (generated if not provided)
	 */
	createRow(rowId?: string): string;

	/**
	 * Create a new row with initial cells.
	 * @param opts - Options with optional ID and initial cells
	 */
	createRow(opts: { id?: string; cells?: Record<string, CellValue> }): string;

	/** Set all cells for a row at once (replaces existing cells) */
	setRow(rowId: string, cells: Record<string, CellValue>): void;

	/** Delete a row (hard delete - removes all cells) */
	deleteRow(rowId: string): void;

	// ═══════════════════════════════════════════════════════════════
	// BULK OPERATIONS (validated)
	// ═══════════════════════════════════════════════════════════════

	/** Get all rows with validation results */
	getAll(): RowResult<RowData>[];
	/** Get all valid rows (filters out invalid ones) */
	getAllValid(): RowData[];
	/** Get all invalid rows with error details */
	getAllInvalid(): InvalidRowResult[];
	/** Get all row IDs */
	getRowIds(): string[];

	// ═══════════════════════════════════════════════════════════════
	// OBSERVATION
	// ═══════════════════════════════════════════════════════════════

	/** Observe changes to cells */
	observe(handler: ChangeHandler<CellValue>): () => void;
};

// ════════════════════════════════════════════════════════════════════════════
// KV Store
// ════════════════════════════════════════════════════════════════════════════

/** Helper for workspace-level key-value pairs. */
export type GridKvStore = {
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
// Grid Workspace Client
// ════════════════════════════════════════════════════════════════════════════

/**
 * The main Grid Workspace client.
 *
 * Provides access to table helpers and KV store with validation.
 */
export type GridWorkspaceClient<
	TTableDefs extends
		readonly GridTableDefinition[] = readonly GridTableDefinition[],
	TExtensions = {},
> = {
	// ═══════════════════════════════════════════════════════════════
	// IDENTITY
	// ═══════════════════════════════════════════════════════════════

	/** Workspace identifier (no epoch suffix) */
	id: string;
	/** Current epoch number (0 if no HeadDoc) */
	epoch: number;
	/** The underlying Y.Doc instance */
	ydoc: Y.Doc;

	// ═══════════════════════════════════════════════════════════════
	// METADATA (from definition)
	// ═══════════════════════════════════════════════════════════════

	/** Display name of the workspace */
	name: string;
	/** Description of the workspace */
	description: string;
	/** Icon for the workspace */
	icon: Icon | null;
	/** The full workspace definition (access schema here) */
	definition: GridWorkspaceDefinition;

	// ═══════════════════════════════════════════════════════════════
	// DATA ACCESS
	// ═══════════════════════════════════════════════════════════════

	/**
	 * Get a table helper. Creates the underlying Y.Array if it doesn't exist.
	 * Table helpers are cached - calling with same tableId returns same instance.
	 */
	table<K extends TTableDefs[number]['id']>(tableId: K): GridTableHelper;
	table(tableId: string): GridTableHelper;

	/** KV store for workspace-level values */
	kv: GridKvStore;

	// ═══════════════════════════════════════════════════════════════
	// LIFECYCLE
	// ═══════════════════════════════════════════════════════════════

	/** Batch multiple writes into a single Y.Doc transaction */
	batch<T>(fn: (ws: GridWorkspaceClient<TTableDefs, TExtensions>) => T): T;

	/** Resolves when all extensions are synced/ready */
	whenSynced: Promise<void>;

	/** Destroy the workspace client and release resources */
	destroy(): Promise<void>;

	/** Extension exports */
	extensions: TExtensions;
};

// ════════════════════════════════════════════════════════════════════════════
// Factory Options
// ════════════════════════════════════════════════════════════════════════════

/**
 * Options for creating a Grid Workspace.
 *
 * The workspace ID is required in the options.
 */
export type CreateGridWorkspaceOptions = {
	/**
	 * Unique identifier for the workspace.
	 *
	 * Required. Grid workspaces require the ID to be passed in options.
	 */
	id: string;

	/** Workspace definition (schema for tables and KV) - always required */
	definition: GridWorkspaceDefinition;

	/**
	 * Optional HeadDoc for time travel support.
	 *
	 * When present:
	 * - Y.Doc GUID becomes `{workspaceId}-{epoch}`
	 * - Garbage collection is disabled
	 * - Time travel / snapshots are enabled
	 *
	 * When absent:
	 * - Y.Doc GUID is just `{workspaceId}`
	 * - Garbage collection is enabled
	 * - No time travel
	 */
	headDoc?: GridHeadDoc;

	/** Optional existing Y.Doc to use instead of creating new */
	ydoc?: Y.Doc;
};
