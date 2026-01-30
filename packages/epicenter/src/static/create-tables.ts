/**
 * createTables() - Lower-level API for binding table definitions to an existing Y.Doc.
 *
 * @example
 * ```typescript
 * import * as Y from 'yjs';
 * import { createTables, defineTable } from 'epicenter/static';
 * import { type } from 'arktype';
 *
 * const posts = defineTable(type({ id: 'string', title: 'string' }));
 *
 * const ydoc = new Y.Doc({ guid: 'my-doc' });
 * const tables = createTables(ydoc, { posts });
 *
 * tables.posts.set({ id: '1', title: 'Hello' });
 * ```
 */

import type * as Y from 'yjs';
import {
	YKeyValueLww,
	type YKeyValueLwwEntry,
} from '../core/utils/y-keyvalue-lww.js';
import { createTableHelper } from './table-helper.js';
import type {
	InferTableRow,
	TableDefinition,
	TableDefinitions,
	TableHelper,
	TablesHelper,
} from './types.js';

/**
 * Binds table definitions to an existing Y.Doc.
 *
 * Creates a TablesHelper object with a TableHelper for each table definition.
 * Tables are stored in the Y.Doc under `table:{tableName}` arrays.
 *
 * @param ydoc - The Y.Doc to bind tables to
 * @param definitions - Map of table name to TableDefinition
 * @returns TablesHelper with type-safe access to each table
 */
export function createTables<TTableDefinitions extends TableDefinitions>(
	ydoc: Y.Doc,
	definitions: TTableDefinitions,
): TablesHelper<TTableDefinitions> {
	const helpers: Record<string, TableHelper<{ id: string }>> = {};

	for (const [name, definition] of Object.entries(definitions)) {
		// Each table gets its own Y.Array for isolation
		const yarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>(`table:${name}`);
		const ykv = new YKeyValueLww(yarray);

		helpers[name] = createTableHelper(ykv, definition);
	}

	return helpers as TablesHelper<TTableDefinitions>;
}

// Re-export types for convenience
export type { InferTableRow, TableDefinition, TableDefinitions, TablesHelper };
