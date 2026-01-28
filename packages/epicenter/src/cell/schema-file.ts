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

import type { WorkspaceSchema, SchemaTableDefinition, SchemaFieldDefinition } from './types';

/**
 * Parse a schema from JSON string.
 *
 * @param json - JSON string containing schema data
 * @returns Parsed WorkspaceSchema
 * @throws Error if JSON is invalid or schema structure is malformed
 */
export function parseSchema(json: string): WorkspaceSchema {
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
			throw new Error(`Table "${tableId}" must have a "fields" object property`);
		}

		// Validate field structure
		const fields = tableObj.fields as Record<string, unknown>;
		for (const [fieldId, field] of Object.entries(fields)) {
			if (!field || typeof field !== 'object') {
				throw new Error(`Field "${tableId}.${fieldId}" must be an object`);
			}

			const fieldObj = field as Record<string, unknown>;
			if (typeof fieldObj.name !== 'string') {
				throw new Error(`Field "${tableId}.${fieldId}" must have a "name" string property`);
			}
			if (typeof fieldObj.type !== 'string') {
				throw new Error(`Field "${tableId}.${fieldId}" must have a "type" string property`);
			}
			if (typeof fieldObj.order !== 'number') {
				throw new Error(`Field "${tableId}.${fieldId}" must have an "order" number property`);
			}
		}
	}

	return data as WorkspaceSchema;
}

/**
 * Serialize a schema to JSON string.
 *
 * @param schema - WorkspaceSchema to serialize
 * @param pretty - Whether to format with indentation (default: true)
 * @returns JSON string
 */
export function stringifySchema(schema: WorkspaceSchema, pretty = true): string {
	return JSON.stringify(schema, null, pretty ? 2 : undefined);
}

/**
 * Create an empty schema with a name.
 *
 * @param name - Display name for the workspace
 * @param icon - Optional icon for the workspace
 * @returns A new WorkspaceSchema with no tables
 */
export function createEmptySchema(name: string, icon?: string): WorkspaceSchema {
	return {
		name,
		icon: icon ?? null,
		tables: {},
		kv: {},
	};
}

/**
 * Add a table to a schema (immutable).
 *
 * @param schema - Existing schema
 * @param tableId - ID for the new table
 * @param table - Table definition
 * @returns New schema with the table added
 */
export function addTable(
	schema: WorkspaceSchema,
	tableId: string,
	table: SchemaTableDefinition,
): WorkspaceSchema {
	return {
		...schema,
		tables: {
			...schema.tables,
			[tableId]: table,
		},
	};
}

/**
 * Remove a table from a schema (immutable).
 *
 * @param schema - Existing schema
 * @param tableId - ID of the table to remove
 * @returns New schema without the table
 */
export function removeTable(
	schema: WorkspaceSchema,
	tableId: string,
): WorkspaceSchema {
	const { [tableId]: _, ...tables } = schema.tables;
	return {
		...schema,
		tables,
	};
}

/**
 * Add a field to a table in a schema (immutable).
 *
 * @param schema - Existing schema
 * @param tableId - ID of the table to modify
 * @param fieldId - ID for the new field
 * @param field - Field definition
 * @returns New schema with the field added
 */
export function addField(
	schema: WorkspaceSchema,
	tableId: string,
	fieldId: string,
	field: SchemaFieldDefinition,
): WorkspaceSchema {
	const table = schema.tables[tableId];
	if (!table) {
		throw new Error(`Table "${tableId}" not found in schema`);
	}

	return {
		...schema,
		tables: {
			...schema.tables,
			[tableId]: {
				...table,
				fields: {
					...table.fields,
					[fieldId]: field,
				},
			},
		},
	};
}

/**
 * Remove a field from a table in a schema (immutable).
 *
 * @param schema - Existing schema
 * @param tableId - ID of the table to modify
 * @param fieldId - ID of the field to remove
 * @returns New schema without the field
 */
export function removeField(
	schema: WorkspaceSchema,
	tableId: string,
	fieldId: string,
): WorkspaceSchema {
	const table = schema.tables[tableId];
	if (!table) {
		throw new Error(`Table "${tableId}" not found in schema`);
	}

	const { [fieldId]: _, ...fields } = table.fields;

	return {
		...schema,
		tables: {
			...schema.tables,
			[tableId]: {
				...table,
				fields,
			},
		},
	};
}

/**
 * Get sorted fields for a table.
 *
 * @param table - Table definition
 * @returns Array of [fieldId, field] tuples sorted by order
 */
export function getSortedFields(
	table: SchemaTableDefinition,
): Array<[string, SchemaFieldDefinition]> {
	return Object.entries(table.fields).sort(([, a], [, b]) => a.order - b.order);
}

/**
 * Calculate the next order value for a new field.
 *
 * @param table - Table definition
 * @returns The next order value (max + 1, or 1 if no fields)
 */
export function getNextFieldOrder(table: SchemaTableDefinition): number {
	const orders = Object.values(table.fields).map((f) => f.order);
	return orders.length > 0 ? Math.max(...orders) + 1 : 1;
}
