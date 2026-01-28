/**
 * ValidatedTableStore - Adds TypeBox validation to TableStore.
 *
 * @deprecated Use the consolidated TableStore which now includes validation.
 * The new TableStore has validation built-in:
 * - `table.get()` returns validated results
 * - `table.getRow()` returns validated results
 * - `table.getAll()` returns all rows with validation status
 * - `table.getAllValid()` returns only valid rows
 * - `table.getAllInvalid()` returns only invalid rows
 * - `table.raw.*` provides unvalidated access
 *
 * @packageDocumentation
 */

import { Compile, type Validator } from 'typebox/compile';
import type { TProperties, TSchema } from 'typebox';
import type { SchemaTableDefinition, TableStore, RowData } from './types';
import type {
	GetCellResult,
	InvalidRowResult,
	GetResult,
	RowResult,
	ValidationError,
} from './validation-types';
import { schemaFieldToTypebox, schemaTableToTypebox } from './converters/to-typebox';

/**
 * A TableStore wrapper that adds TypeBox validation.
 *
 * Provides validated access at both cell and row levels:
 * - Cell-level: `getValidated(rowId, fieldId)` validates a single cell
 * - Row-level: `getRowValidated(rowId)` validates an entire row
 *
 * The underlying raw TableStore remains accessible for schema-agnostic operations.
 */
export type ValidatedTableStore = {
	/** The table identifier */
	readonly tableId: string;
	/** The schema definition for this table */
	readonly schema: SchemaTableDefinition;
	/** The underlying raw TableStore for schema-agnostic access */
	readonly raw: TableStore;

	/**
	 * Get a validated cell value.
	 *
	 * @param rowId - The row identifier
	 * @param fieldId - The field identifier
	 * @returns Valid result with typed value, invalid result with errors, or not_found
	 */
	getValidated(rowId: string, fieldId: string): GetCellResult<unknown>;

	/**
	 * Get a validated row.
	 *
	 * @param rowId - The row identifier
	 * @returns Valid result with row data, invalid result with errors, or not_found
	 */
	getRowValidated(rowId: string): GetResult<RowData>;

	/**
	 * Get all rows with validation results.
	 *
	 * @returns Array of valid or invalid row results
	 */
	getRowsValidated(): RowResult<RowData>[];

	/**
	 * Get all valid rows (filters out invalid ones).
	 *
	 * @returns Array of row data that passed validation
	 */
	getRowsValid(): RowData[];

	/**
	 * Get all invalid rows.
	 *
	 * @returns Array of invalid row results with error details
	 */
	getRowsInvalid(): InvalidRowResult[];
};

/**
 * Creates a ValidatedTableStore wrapping a TableStore with TypeBox validation.
 *
 * @deprecated Use `createTableStore()` with a schema parameter instead.
 * The new consolidated TableStore includes validation automatically.
 *
 * @param tableId - The table identifier
 * @param schema - The table schema definition
 * @param tableStore - The underlying TableStore to wrap
 * @returns A ValidatedTableStore with validation methods
 *
 * @example
 * ```typescript
 * // OLD WAY (deprecated):
 * const validated = createValidatedTableStore('posts', schema, rawStore);
 *
 * // NEW WAY:
 * const store = createTableStore('posts', yarray, schema);
 * // store.get() returns validated results
 * // store.raw.get() returns unvalidated access
 * ```
 */
export function createValidatedTableStore(
	tableId: string,
	schema: SchemaTableDefinition,
	tableStore: TableStore,
): ValidatedTableStore {
	// Compile validators once at construction
	const rowSchema = schemaTableToTypebox(schema);
	const rowValidator = Compile(rowSchema);

	// Compile field validators lazily and cache them
	const fieldValidators = new Map<string, Validator<TProperties, TSchema>>();

	function getFieldValidator(fieldId: string): Validator<TProperties, TSchema> | undefined {
		let validator = fieldValidators.get(fieldId);
		if (validator) return validator;

		const fieldDef = schema.fields[fieldId];
		if (!fieldDef) return undefined;

		const fieldSchema = schemaFieldToTypebox(fieldDef);
		validator = Compile(fieldSchema);
		fieldValidators.set(fieldId, validator);
		return validator;
	}

	function getValidated(rowId: string, fieldId: string): GetCellResult<unknown> {
		const key = `${rowId}:${fieldId}`;
		const value = tableStore.raw.get(rowId, fieldId);

		// Check if cell exists
		if (value === undefined && !tableStore.has(rowId, fieldId)) {
			return { status: 'not_found', key };
		}

		// Get field validator
		const validator = getFieldValidator(fieldId);

		// Fields not in schema pass validation (advisory behavior)
		if (!validator) {
			return { status: 'valid', value };
		}

		// Validate the cell value
		if (validator.Check(value)) {
			return { status: 'valid', value };
		}

		const errors: ValidationError[] = [...validator.Errors(value)];
		return { status: 'invalid', key, errors, value };
	}

	function getRowValidated(rowId: string): GetResult<RowData> {
		const cells = tableStore.raw.getRow(rowId);

		if (!cells) {
			return { status: 'not_found', id: rowId };
		}

		const row: RowData = { id: rowId, cells };

		if (rowValidator.Check(cells)) {
			return { status: 'valid', row };
		}

		const errors: ValidationError[] = [...rowValidator.Errors(cells)];
		return {
			status: 'invalid',
			id: rowId,
			tableName: tableId,
			errors,
			row: cells,
		};
	}

	function getRowsValidated(): RowResult<RowData>[] {
		const rows = tableStore.raw.getRows();
		const results: RowResult<RowData>[] = [];

		for (const row of rows) {
			if (rowValidator.Check(row.cells)) {
				results.push({ status: 'valid', row });
			} else {
				const errors: ValidationError[] = [...rowValidator.Errors(row.cells)];
				results.push({
					status: 'invalid',
					id: row.id,
					tableName: tableId,
					errors,
					row: row.cells,
				});
			}
		}

		return results;
	}

	function getRowsValid(): RowData[] {
		const rows = tableStore.raw.getRows();
		return rows.filter((row) => rowValidator.Check(row.cells));
	}

	function getRowsInvalid(): InvalidRowResult[] {
		const rows = tableStore.raw.getRows();
		const results: InvalidRowResult[] = [];

		for (const row of rows) {
			if (!rowValidator.Check(row.cells)) {
				const errors: ValidationError[] = [...rowValidator.Errors(row.cells)];
				results.push({
					status: 'invalid',
					id: row.id,
					tableName: tableId,
					errors,
					row: row.cells,
				});
			}
		}

		return results;
	}

	return {
		tableId,
		schema,
		raw: tableStore,
		getValidated,
		getRowValidated,
		getRowsValidated,
		getRowsValid,
		getRowsInvalid,
	};
}
