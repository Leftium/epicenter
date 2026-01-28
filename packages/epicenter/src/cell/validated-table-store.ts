/**
 * ValidatedTableStore - Adds TypeBox validation to TableStore.
 *
 * Wraps a raw TableStore to provide validated access to cells and rows.
 * Validators are compiled once at construction for performance.
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
 * @param tableId - The table identifier
 * @param schema - The table schema definition
 * @param tableStore - The underlying TableStore to wrap
 * @returns A ValidatedTableStore with validation methods
 *
 * @example
 * ```typescript
 * const schema = {
 *   name: 'Posts',
 *   fields: {
 *     title: { name: 'Title', type: 'text', order: 1 },
 *     views: { name: 'Views', type: 'integer', order: 2 },
 *   }
 * };
 *
 * const validated = createValidatedTableStore('posts', schema, rawStore);
 *
 * // Cell-level validation
 * const cellResult = validated.getValidated('row-1', 'views');
 * if (cellResult.status === 'valid') {
 *   console.log('Views:', cellResult.value);
 * }
 *
 * // Row-level validation
 * const rowResult = validated.getRowValidated('row-1');
 * if (rowResult.status === 'valid') {
 *   console.log('Row:', rowResult.row);
 * }
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
		const value = tableStore.get(rowId, fieldId);

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
		const cells = tableStore.getRow(rowId);

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
		const rows = tableStore.getRows();
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
		const rows = tableStore.getRows();
		return rows.filter((row) => rowValidator.Check(row.cells));
	}

	function getRowsInvalid(): InvalidRowResult[] {
		const rows = tableStore.getRows();
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
