/**
 * Dynamic Table Helper
 *
 * A unified helper for a single table with integrated validation.
 * Every entry is a cell value stored in a Y.Array.
 *
 * Y.Doc structure:
 * ```
 * Y.Array(tableId)              <- One array per table
 * +-- { key: 'row1:title',      val: 'Hello',  ts: ... }
 * +-- { key: 'row1:views',      val: 100,      ts: ... }
 * +-- ...
 * ```
 *
 * @packageDocumentation
 */

import { type TObject, type TProperties, type TSchema, Type } from 'typebox';
import { Compile, type Validator } from 'typebox/compile';
import type * as Y from 'yjs';
import type { Field } from '../core/schema/fields/types';
import {
	YKeyValueLww,
	type YKeyValueLwwChange,
	type YKeyValueLwwEntry,
} from '../core/utils/y-keyvalue-lww';
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
	ChangeEvent,
	ChangeHandler,
	GetCellResult,
	GetResult,
	InvalidRowResult,
	RowData,
	RowResult,
	TableDef,
	TableHelper,
	ValidationError,
} from './types';

/** Convert a Field to its TypeBox schema. */
function fieldToTypebox(field: Field): TSchema {
	switch (field.type) {
		case 'id':
		case 'text':
		case 'richtext':
		case 'date':
			return Type.String();
		case 'integer':
			return Type.Integer();
		case 'real':
			return Type.Number();
		case 'boolean':
			return Type.Boolean();
		case 'select':
			return Type.Union(field.options.map((v) => Type.Literal(v)));
		case 'tags': {
			const opts = field.options;
			if (opts?.length) return Type.Array(Type.Union(opts.map((v) => Type.Literal(v))));
			return Type.Array(Type.String());
		}
		case 'json':
			return Type.Unknown();
	}
}

/** Convert a TableDef to a TypeBox object schema. */
function tableToTypebox(table: TableDef): TObject {
	const properties: Record<string, TSchema> = {};
	for (const field of table.fields) {
		properties[field.id] = Type.Optional(fieldToTypebox(field));
	}
	return Type.Object(properties, { additionalProperties: true });
}

/**
 * Create a table helper backed by a Y.Array.
 *
 * @param tableId - The table identifier (used for error messages)
 * @param yarray - The Y.Array for this table's data
 * @param schema - Schema for validation
 */
export function createTableHelper(
	tableId: string,
	yarray: Y.Array<YKeyValueLwwEntry<CellValue>>,
	schema: TableDef,
): TableHelper {
	const ykv = new YKeyValueLww<CellValue>(yarray);

	// Compile validators once at construction
	const rowValidator = Compile(tableToTypebox(schema));

	// Compile field validators lazily and cache them
	const fieldValidators = new Map<string, Validator<TProperties, TSchema>>();

	function getFieldValidator(
		fieldId: string,
	): Validator<TProperties, TSchema> | undefined {
		let validator = fieldValidators.get(fieldId);
		if (validator) return validator;

		const fieldDef = schema.fields.find((f) => f.id === fieldId);
		if (!fieldDef) return undefined;

		const fieldSchema = fieldToTypebox(fieldDef);
		validator = Compile(fieldSchema);
		fieldValidators.set(fieldId, validator);
		return validator;
	}

	// ══════════════════════════════════════════════════════════════════════
	// Internal Raw Operations
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

		// ═══════════════════════════════════════════════════════════════
		// CELL OPERATIONS
		// ═══════════════════════════════════════════════════════════════

		getCell(rowId: string, fieldId: string): GetCellResult<unknown> {
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

		setCell(rowId: string, fieldId: string, value: CellValue): void {
			validateId(rowId, 'rowId');
			validateId(fieldId, 'fieldId');
			ykv.set(CellKey(RowId(rowId), FieldId(fieldId)), value);
		},

		deleteCell(rowId: string, fieldId: string): void {
			ykv.delete(CellKey(RowId(rowId), FieldId(fieldId)));
		},

		hasCell(rowId: string, fieldId: string): boolean {
			return ykv.has(CellKey(RowId(rowId), FieldId(fieldId)));
		},

		// ═══════════════════════════════════════════════════════════════
		// ROW OPERATIONS
		// ═══════════════════════════════════════════════════════════════

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

		createRow(
			idOrOpts?: string | { id?: string; cells?: Record<string, CellValue> },
		): string {
			// Handle overloads
			if (typeof idOrOpts === 'string' || idOrOpts === undefined) {
				// Simple overload: createRow(rowId?)
				const newId = idOrOpts ?? generateRowId();
				if (idOrOpts) validateId(idOrOpts, 'rowId');
				return newId;
			}

			// Options overload: createRow({ id?, cells? })
			const { id, cells } = idOrOpts;
			const newId = id ?? generateRowId();
			if (id) validateId(id, 'rowId');

			// Set initial cells if provided
			if (cells) {
				for (const [fieldId, value] of Object.entries(cells)) {
					this.setCell(newId, fieldId, value);
				}
			}

			return newId;
		},

		setRow(rowId: string, cells: Record<string, CellValue>): void {
			validateId(rowId, 'rowId');

			// First, delete all existing cells for this row
			this.deleteRow(rowId);

			// Then set all new cells
			for (const [fieldId, value] of Object.entries(cells)) {
				this.setCell(rowId, fieldId, value);
			}
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

		// ═══════════════════════════════════════════════════════════════
		// BULK OPERATIONS
		// ═══════════════════════════════════════════════════════════════

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

		// ═══════════════════════════════════════════════════════════════
		// OBSERVATION
		// ═══════════════════════════════════════════════════════════════

		observe(handler: ChangeHandler<CellValue>): () => void {
			const ykvHandler = (
				changes: Map<string, YKeyValueLwwChange<CellValue>>,
				transaction: Y.Transaction,
			) => {
				const events: ChangeEvent<CellValue>[] = [];

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
