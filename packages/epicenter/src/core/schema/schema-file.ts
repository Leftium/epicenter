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

import type { Field, TableDefinition } from './fields/types';
import { normalizeIcon } from './fields/types';
import type { WorkspaceDefinition } from './workspace-definition';

/**
 * Get a table by its ID from an array of tables.
 *
 * @param tables - The array of table definitions to search
 * @param tableId - The ID of the table to find
 * @returns The table definition if found, undefined otherwise
 */
export function getTableById(
	tables: readonly TableDefinition<readonly Field[]>[],
	tableId: string,
): TableDefinition<readonly Field[]> | undefined {
	return tables.find((t) => t.id === tableId);
}

/**
 * Safely normalize icon from unknown JSON input.
 * Handles the type narrowing before calling normalizeIcon.
 */
function normalizeIconFromJson(
	icon: unknown,
): ReturnType<typeof normalizeIcon> {
	if (typeof icon === 'string') return normalizeIcon(icon);
	return null;
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

	if (typeof obj.id !== 'string') {
		throw new Error('Schema must have an "id" string property');
	}

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
	const normalizedTables: TableDefinition<readonly Field[]>[] = [];

	// Normalize tables
	for (const [tableId, tableData] of Object.entries(tables)) {
		const tableObj = tableData as Record<string, unknown>;

		// Normalize fields to array format (supports both Record and Array input)
		const rawFields = tableObj.fields;
		const normalizedFields: Field[] = Array.isArray(rawFields)
			? ((rawFields as Array<Record<string, unknown>>).map((f) => ({
					...(f as object),
					id: (f.id as string) ?? '',
				})) as Field[])
			: Object.entries(rawFields as Record<string, unknown>).map(
					([id, f]) =>
						({
							...(f as object),
							id,
						}) as Field,
				);

		normalizedTables.push({
			id: tableId,
			name: tableObj.name as string,
			description: (tableObj.description as string) ?? '',
			icon: normalizeIconFromJson(tableObj.icon),
			fields: normalizedFields,
		});
	}

	const normalized: WorkspaceDefinition = {
		id: obj.id as string,
		name: obj.name as string,
		description: (obj.description as string) ?? '',
		icon: normalizeIconFromJson(obj.icon),
		tables: normalizedTables,
		kv: obj.kv as WorkspaceDefinition['kv'],
	};

	return normalized;
}
