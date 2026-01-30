/**
 * Table Helper for Cell Workspace
 *
 * A unified helper for a single table with integrated validation.
 * Every entry is a cell value.
 *
 * Y.Doc structure:
 * ```
 * Y.Array(tableId)              ← One array per table
 * ├── { key: 'row1:title',      val: 'Hello',  ts: ... }
 * ├── { key: 'row1:views',      val: 100,      ts: ... }
 * └── ...
 * ```
 *
 * @packageDocumentation
 */

import type { TProperties, TSchema } from 'typebox';
import { Compile, type Validator } from 'typebox/compile';
import type * as Y from 'yjs';
import {
	YKeyValueLww,
	type YKeyValueLwwEntry,
} from '../core/utils/y-keyvalue-lww';
import {
	schemaFieldToTypebox,
	schemaTableToTypebox,
} from './converters/to-typebox';
import {
	CellKey,
	FieldId,
	generateRowId,
	hasPrefix,
	parseCellKey,
	RowId,
	RowPrefix,
	validateId,
} from './keys';

import type {
	CellValue,
	ChangeHandler,
	RowData,
	SchemaTableDefinition,
	TableHelper,
} from './types';
import type {
	GetCellResult,
	GetResult,
	InvalidRowResult,
	RowResult,
	ValidationError,
} from './validation-types';

/**
 * Create a table helper backed by a Y.Array.
 *
 * @param tableId - The table identifier (used for error messages)
 * @param yarray - The Y.Array for this table's data
 * @param schema - Schema for validation (use empty `{ name, fields: {} }` for dynamic tables)
 */
export function createTableHelper(
	tableId: string,
	yarray: Y.Array<YKeyValueLwwEntry<CellValue>>,
	schema: SchemaTableDefinition,
): TableHelper {
	const ykv = new YKeyValueLww<CellValue>(yarray);

	// Compile validators once at construction
	const rowValidator = Compile(schemaTableToTypebox(schema));

	// Compile field validators lazily and cache them
	const fieldValidators = new Map<string, Validator<TProperties, TSchema>>();

	function getFieldValidator(
		fieldId: string,
	): Validator<TProperties, TSchema> | undefined {
		let validator = fieldValidators.get(fieldId);
		if (validator) return validator;

		const fieldDef = schema.fields.find((f) => f.id === fieldId);
		if (!fieldDef) return undefined;

		const fieldSchema = schemaFieldToTypebox(fieldDef);
		validator = Compile(fieldSchema);
		fieldValidators.set(fieldId, validator);
		return validator;
	}

	// ══════════════════════════════════════════════════════════════════════
	// Internal Raw Operations (used by validated methods)
	// ══════════════════════════════════════════════════════════════════════

	function rawGet(rowId: string, fieldId: string): CellValue | undefined {
		return ykv.get(CellKey(RowId(rowId), FieldId(fieldId)));
	}

	function rawGetRow(rowId: string): Record<string, CellValue> | undefined {
		const prefix = RowPrefix(RowId(rowId));
		const cells: Record<string, CellValue> = {};
		let found = false;

		for (const [key, entry] of ykv.map) {
			if (hasPrefix(key, prefix)) {
				const parsed = parseCellKey(key);
				cells[parsed.fieldId] = entry.val;
				found = true;
			}
		}

		return found ? cells : undefined;
	}

	function rawGetRows(): RowData[] {
		// Group cells by rowId
		const rowsMap = new Map<string, Record<string, CellValue>>();

		for (const [key, entry] of ykv.map) {
			const { rowId, fieldId } = parseCellKey(key);
			let row = rowsMap.get(rowId);
			if (!row) {
				row = {};
				rowsMap.set(rowId, row);
			}
			row[fieldId] = entry.val;
		}

		// Convert to array, sorted by id for deterministic ordering
		const rows: RowData[] = [];
		for (const [id, cells] of rowsMap) {
			rows.push({ id, cells });
		}

		return rows.sort((a, b) => a.id.localeCompare(b.id));
	}

	return {
		tableId,
		schema,

		// Cell operations (validated)
		get(rowId: string, fieldId: string): GetCellResult<unknown> {
			const key = `${rowId}:${fieldId}`;
			const value = rawGet(rowId, fieldId);

			// Check if cell exists
			if (
				value === undefined &&
				!ykv.has(CellKey(RowId(rowId), FieldId(fieldId)))
			) {
				return { status: 'not_found', key, value: undefined };
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
		},

		set(rowId: string, fieldId: string, value: CellValue): void {
			validateId(rowId, 'rowId');
			validateId(fieldId, 'fieldId');
			ykv.set(CellKey(RowId(rowId), FieldId(fieldId)), value);
		},

		delete(rowId: string, fieldId: string): void {
			ykv.delete(CellKey(RowId(rowId), FieldId(fieldId)));
		},

		has(rowId: string, fieldId: string): boolean {
			return ykv.has(CellKey(RowId(rowId), FieldId(fieldId)));
		},

		// Row operations (validated)
		getRow(rowId: string): GetResult<RowData> {
			const cells = rawGetRow(rowId);

			if (!cells) {
				return { status: 'not_found', id: rowId, row: undefined };
			}

			const rowData: RowData = { id: rowId, cells };

			if (rowValidator.Check(cells)) {
				return { status: 'valid', row: rowData };
			}

			const errors: ValidationError[] = [...rowValidator.Errors(cells)];
			return {
				status: 'invalid',
				id: rowId,
				tableName: tableId,
				errors,
				row: cells,
			};
		},

		createRow(id?: string): string {
			const newId = id ?? generateRowId();
			if (id) validateId(id, 'rowId');
			// Row is "created" implicitly when you set cells on it
			// This just generates/validates the ID
			return newId;
		},

		deleteRow(rowId: string): void {
			// Hard delete - remove all cells for this row
			const prefix = RowPrefix(RowId(rowId));
			const keysToDelete: string[] = [];

			for (const [key] of ykv.map) {
				if (hasPrefix(key, prefix)) {
					keysToDelete.push(key);
				}
			}

			for (const key of keysToDelete) {
				ykv.delete(key);
			}
		},

		// Bulk operations (validated)
		getAll(): RowResult<RowData>[] {
			const rows = rawGetRows();
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
		},

		getAllValid(): RowData[] {
			const rows = rawGetRows();
			return rows.filter((row) => rowValidator.Check(row.cells));
		},

		getAllInvalid(): InvalidRowResult[] {
			const rows = rawGetRows();
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
		},

		getRowIds(): string[] {
			const ids = new Set<string>();
			for (const [key] of ykv.map) {
				const { rowId } = parseCellKey(key);
				ids.add(rowId);
			}
			return Array.from(ids).sort();
		},

		// Observation
		observe(handler: ChangeHandler<CellValue>): () => void {
			const ykvHandler = (
				changes: Map<
					string,
					import('../core/utils/y-keyvalue-lww').YKeyValueLwwChange<CellValue>
				>,
				transaction: Y.Transaction,
			) => {
				const events: import('./types').ChangeEvent<CellValue>[] = [];

				for (const [key, change] of changes) {
					if (change.action === 'add') {
						events.push({ type: 'add', key, value: change.newValue });
					} else if (change.action === 'update') {
						events.push({
							type: 'update',
							key,
							value: change.newValue,
							previousValue: change.oldValue,
						});
					} else if (change.action === 'delete') {
						events.push({
							type: 'delete',
							key,
							previousValue: change.oldValue,
						});
					}
				}

				if (events.length > 0) {
					handler(events, transaction);
				}
			};

			ykv.observe(ykvHandler);
			return () => ykv.unobserve(ykvHandler);
		},
	};
}
