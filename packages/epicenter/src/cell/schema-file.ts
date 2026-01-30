/**
 * Schema File Utilities
 *
 * Functions for loading and saving external schema JSON files.
 *
 * Schema files define the "lens" through which you view workspace data.
 * They are stored separately from the Y.Doc and are NOT synced via CRDT.
 *
 * File structure:
 * ```
 * {workspaceId}.json        # Schema definitions (local only)
 * {workspaceId}/
 *   workspace.yjs           # CRDT data (synced)
 * ```
 *
 * @packageDocumentation
 */

import type { Icon } from '../core/schema/fields/types';
import { isIcon } from '../core/schema/fields/types';
import type {
	SchemaFieldDefinition,
	SchemaTableDefinition,
	WorkspaceDefinition,
} from './types';

/**
 * Get a field by its ID from a table.
 *
 * @param table - The table definition to search
 * @param fieldId - The ID of the field to find
 * @returns The field definition if found, undefined otherwise
 */
export function getFieldById(
	table: SchemaTableDefinition,
	fieldId: string,
): SchemaFieldDefinition | undefined {
	return table.fields.find((f) => f.id === fieldId);
}

/**
 * Get a table by its ID from an array of tables.
 *
 * @param tables - The array of table definitions to search
 * @param tableId - The ID of the table to find
 * @returns The table definition if found, undefined otherwise
 */
export function getTableById(
	tables: readonly SchemaTableDefinition[],
	tableId: string,
): SchemaTableDefinition | undefined {
	return tables.find((t) => t.id === tableId);
}

/**
 * Get all field IDs from a table.
 *
 * @param table - The table definition
 * @returns Array of field IDs in order
 */
export function getFieldIds(table: SchemaTableDefinition): string[] {
	return table.fields.map((f) => f.id);
}

/**
 * Normalize icon input to Icon | null.
 */
function normalizeIcon(icon: unknown): Icon | null {
	if (icon === undefined || icon === null) return null;
	if (typeof icon !== 'string') return null;
	if (isIcon(icon)) return icon;
	return `emoji:${icon}` as Icon;
}

/**
 * Parse a schema from JSON string.
 *
 * @param json - JSON string containing schema data
 * @returns Parsed WorkspaceDefinition
 * @throws Error if JSON is invalid or schema structure is malformed
 */
export function parseSchema(json: string): WorkspaceDefinition {
	const data = JSON.parse(json) as unknown;

	if (!data || typeof data !== 'object') {
		throw new Error('Schema must be an object');
	}

	const obj = data as Record<string, unknown>;

	if (typeof obj.name !== 'string') {
		throw new Error('Schema must have a "name" string property');
	}

	if (!obj.tables || typeof obj.tables !== 'object') {
		throw new Error('Schema must have a "tables" object property');
	}

	// Validate table structure
	const tables = obj.tables as Record<string, unknown>;
	for (const [tableId, table] of Object.entries(tables)) {
		if (!table || typeof table !== 'object') {
			throw new Error(`Table "${tableId}" must be an object`);
		}

		const tableObj = table as Record<string, unknown>;
		if (typeof tableObj.name !== 'string') {
			throw new Error(`Table "${tableId}" must have a "name" string property`);
		}

		if (!tableObj.fields || typeof tableObj.fields !== 'object') {
			throw new Error(
				`Table "${tableId}" must have a "fields" object property`,
			);
		}

		// Validate field structure (supports both Record and Array input)
		const fields = tableObj.fields;
		const fieldEntries: Array<[string, unknown]> = Array.isArray(fields)
			? (fields as Array<{ id?: string } & Record<string, unknown>>).map(
					(f, i) => [f.id ?? `field_${i}`, f],
				)
			: Object.entries(fields as Record<string, unknown>);

		for (const [fieldId, field] of fieldEntries) {
			if (!field || typeof field !== 'object') {
				throw new Error(`Field "${tableId}.${fieldId}" must be an object`);
			}

			const fieldObj = field as Record<string, unknown>;
			if (typeof fieldObj.name !== 'string') {
				throw new Error(
					`Field "${tableId}.${fieldId}" must have a "name" string property`,
				);
			}
			if (typeof fieldObj.type !== 'string') {
				throw new Error(
					`Field "${tableId}.${fieldId}" must have a "type" string property`,
				);
			}
		}
	}

	// Normalize the parsed data
	const normalizedTables: SchemaTableDefinition[] = [];

	// Normalize tables
	for (const [tableId, tableData] of Object.entries(tables)) {
		const tableObj = tableData as Record<string, unknown>;

		// Normalize fields to array format (supports both Record and Array input)
		const rawFields = tableObj.fields;
		const normalizedFields: SchemaFieldDefinition[] = Array.isArray(rawFields)
			? ((rawFields as Array<Record<string, unknown>>).map((f) => ({
					...(f as object),
					id: (f.id as string) ?? '',
				})) as SchemaFieldDefinition[])
			: Object.entries(rawFields as Record<string, unknown>).map(
					([id, f]) =>
						({
							...(f as object),
							id,
						}) as SchemaFieldDefinition,
				);

		normalizedTables.push({
			id: tableId,
			name: tableObj.name as string,
			description: (tableObj.description as string) ?? '',
			icon: normalizeIcon(tableObj.icon),
			fields: normalizedFields,
		});
	}

	const normalized: WorkspaceDefinition = {
		name: obj.name as string,
		description: (obj.description as string) ?? '',
		icon: normalizeIcon(obj.icon),
		tables: normalizedTables,
		kv: obj.kv as WorkspaceDefinition['kv'],
	};

	return normalized;
}

/**
 * Serialize a schema to JSON string.
 *
 * @param definition - WorkspaceDefinition to serialize
 * @param pretty - Whether to format with indentation (default: true)
 * @returns JSON string
 */
export function stringifySchema(
	definition: WorkspaceDefinition,
	pretty = true,
): string {
	return JSON.stringify(definition, null, pretty ? 2 : undefined);
}

/**
 * Create an empty schema with a name.
 *
 * @param name - Display name for the workspace
 * @param icon - Optional icon for the workspace
 * @returns A new WorkspaceDefinition with no tables
 */
export function createEmptySchema(
	name: string,
	icon?: string | Icon | null,
): WorkspaceDefinition {
	return {
		name,
		description: '',
		icon: normalizeIcon(icon),
		tables: [],
		kv: [],
	};
}

/**
 * Add a table to a schema (immutable).
 *
 * @param definition - Existing schema
 * @param tableId - ID for the new table
 * @param table - Table definition
 * @returns New schema with the table added
 */
export function addTable(
	definition: WorkspaceDefinition,
	_tableId: string,
	table: SchemaTableDefinition,
): WorkspaceDefinition {
	// Note: tableId param kept for API compatibility but table.id is authoritative
	return {
		...definition,
		tables: [...definition.tables, table],
	};
}

/**
 * Remove a table from a schema (immutable).
 *
 * @param definition - Existing schema
 * @param tableId - ID of the table to remove
 * @returns New schema without the table
 */
export function removeTable(
	definition: WorkspaceDefinition,
	tableId: string,
): WorkspaceDefinition {
	return {
		...definition,
		tables: definition.tables.filter((t) => t.id !== tableId),
	};
}

/**
 * Add a field to a table in a schema (immutable).
 *
 * @param definition - Existing schema
 * @param tableId - ID of the table to modify
 * @param fieldId - ID for the new field
 * @param field - Field definition (id property will be overwritten with fieldId)
 * @returns New schema with the field added
 */
export function addField(
	definition: WorkspaceDefinition,
	tableId: string,
	fieldId: string,
	field: Omit<SchemaFieldDefinition, 'id'>,
): WorkspaceDefinition {
	const table = getTableById(definition.tables, tableId);
	if (!table) {
		throw new Error(`Table "${tableId}" not found in schema`);
	}

	const newField = { ...field, id: fieldId } as SchemaFieldDefinition;

	return {
		...definition,
		tables: definition.tables.map((t) =>
			t.id === tableId
				? {
						...t,
						fields: [...t.fields, newField],
					}
				: t,
		),
	};
}

/**
 * Remove a field from a table in a schema (immutable).
 *
 * @param definition - Existing schema
 * @param tableId - ID of the table to modify
 * @param fieldId - ID of the field to remove
 * @returns New schema without the field
 */
export function removeField(
	schema: WorkspaceDefinition,
	tableId: string,
	fieldId: string,
): WorkspaceDefinition {
	const table = getTableById(schema.tables, tableId);
	if (!table) {
		throw new Error(`Table "${tableId}" not found in schema`);
	}

	return {
		...schema,
		tables: schema.tables.map((t) =>
			t.id === tableId
				? {
						...t,
						fields: t.fields.filter((f) => f.id !== fieldId),
					}
				: t,
		),
	};
}
