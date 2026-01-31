import type * as Y from 'yjs';
import type { TableDefinition } from '../../core/schema';
import type { TableById } from '../../core/schema/fields/types';
import {
	createTableHelper,
	createUntypedTableHelper,
	type TableHelper,
	type UntypedTableHelper,
} from './table-helper';

// Re-export types for public API
export type {
	GetResult,
	InvalidRowResult,
	RowAction,
	RowChanges,
	RowResult,
	TableHelper,
	UntypedTableHelper,
	ValidRowResult,
} from './table-helper';

/**
 * Object type for accessing tables.
 *
 * The tables object provides table access via `tables.get('posts')`.
 * Utility methods are properties: `tables.has()`, `tables.names()`, etc.
 *
 * This pattern eliminates collision risk between user-defined table names and
 * utility methods, since user names only appear as method arguments.
 */
export type TablesFunction<
	TTableDefinitions extends readonly TableDefinition[],
> = {
	// ════════════════════════════════════════════════════════════════════
	// TABLE ACCESS
	// ════════════════════════════════════════════════════════════════════

	/**
	 * Get a table helper by name (typed version for defined tables).
	 *
	 * @example
	 * ```typescript
	 * tables.get('posts').getAll()  // Row[] - fully typed
	 * ```
	 */
	get<K extends TTableDefinitions[number]['id']>(
		name: K,
	): TableHelper<TableById<TTableDefinitions, K>['fields']>;

	/**
	 * Get a table helper by name (untyped version for dynamic tables).
	 *
	 * @example
	 * ```typescript
	 * tables.get('dynamic').getAll()  // unknown[]
	 * ```
	 */
	get(name: string): UntypedTableHelper;

	// ════════════════════════════════════════════════════════════════════
	// EXISTENCE & ENUMERATION
	// ════════════════════════════════════════════════════════════════════

	/**
	 * Check if a table exists in YJS storage (without creating it).
	 */
	has(name: string): boolean;

	/**
	 * Get all table names that exist in YJS storage.
	 */
	names(): string[];

	// ════════════════════════════════════════════════════════════════════
	// BULK OPERATIONS
	// ════════════════════════════════════════════════════════════════════

	/**
	 * Clear all rows in defined tables.
	 */
	clear(): void;

	// ════════════════════════════════════════════════════════════════════
	// METADATA
	// ════════════════════════════════════════════════════════════════════

	/**
	 * The raw table definitions passed to createTables.
	 */
	definitions: TTableDefinitions;

	// ════════════════════════════════════════════════════════════════════
	// UTILITIES
	// ════════════════════════════════════════════════════════════════════

	/**
	 * Serialize all tables to JSON.
	 */
	toJSON(): Record<string, unknown[]>;
};

/**
 * Create an Epicenter database wrapper with table helpers from an existing Y.Doc.
 * This is a pure function that doesn't handle persistence - it only wraps
 * the Y.Doc with type-safe table operations.
 *
 * The returned object provides table access via the `.get()` method.
 * Utility methods are properties on the object itself.
 *
 * ## API Design
 *
 * Tables are accessed via: `tables.get('posts')`.
 * Utilities are properties: `tables.has()`, `tables.clear()`, etc.
 * This eliminates collision risk between user table names and utility methods.
 *
 * @param ydoc - An existing Y.Doc instance (already loaded/initialized)
 * @param tableDefinitions - Table definitions (use `table()` helper for ergonomic definitions)
 * @returns Object with table helpers and utility methods
 *
 * @example
 * ```typescript
 * const ydoc = new Y.Doc({ guid: 'workspace-123' });
 * const tables = createTables(ydoc, [
 *   table({
 *     id: 'posts',
 *     name: 'Posts',
 *     fields: [id(), text({ id: 'title' }), boolean({ id: 'published' })],
 *   }),
 *   table({
 *     id: 'users',
 *     name: 'Users',
 *     description: 'User accounts',
 *     icon: '👤',
 *     fields: [id(), text({ id: 'name' }), boolean({ id: 'active' })],
 *   }),
 * ]);
 *
 * // Tables are accessed via get()
 * tables.get('posts').upsert({ id: '1', title: 'Hello', published: false });
 * tables.get('posts').getAll();
 *
 * // Clear all tables
 * tables.clear();
 *
 * // With destructuring (unchanged ergonomics)
 * const posts = tables.get('posts');
 * posts.upsert({ id: '1', title: 'Hello', published: false });
 * ```
 */
export function createTables<
	const TTableDefinitions extends readonly TableDefinition[],
>(
	ydoc: Y.Doc,
	tableDefinitions: TTableDefinitions,
): TablesFunction<TTableDefinitions> {
	// Build helpers map from array of table definitions
	const tableHelpers = Object.fromEntries(
		tableDefinitions.map((tableDefinition) => [
			tableDefinition.id,
			createTableHelper({
				ydoc,
				tableDefinition,
			}),
		]),
	) as {
		[K in TTableDefinitions[number]['id']]: TableHelper<
			TableById<TTableDefinitions, K>['fields']
		>;
	};

	// Cache for dynamically-created table helpers (tables not in definition)
	const dynamicTableHelpers = new Map<string, UntypedTableHelper>();

	/**
	 * Get or create an untyped table helper for a dynamic table.
	 */
	const getOrCreateDynamicHelper = (name: string): UntypedTableHelper => {
		let helper = dynamicTableHelpers.get(name);
		if (!helper) {
			helper = createUntypedTableHelper({ ydoc, tableName: name });
			dynamicTableHelpers.set(name, helper);
		}
		return helper;
	};

	// ════════════════════════════════════════════════════════════════════
	// BUILD TABLES OBJECT WITH METHODS
	// ════════════════════════════════════════════════════════════════════

	return {
		// ════════════════════════════════════════════════════════════════════
		// TABLE ACCESS
		// ════════════════════════════════════════════════════════════════════

		/**
		 * Get a table helper by name.
		 *
		 * Returns a typed helper for defined tables, or an untyped helper for
		 * dynamic tables.
		 *
		 * @example
		 * ```typescript
		 * tables.get('posts').upsert({ id: '1', title: 'Hello' });
		 * tables.get('posts').getAll();
		 *
		 * // Dynamic tables are also supported
		 * tables.get('custom').upsert({ id: '1', data: 'value' });
		 * ```
		 */
		get(
			name: string,
		):
			| TableHelper<
					Extract<TTableDefinitions[number], { id: string }>['fields']
			  >
			| UntypedTableHelper {
			// Check if it's a defined table first
			if (name in tableHelpers) {
				return tableHelpers[name as keyof typeof tableHelpers];
			}
			// Otherwise return/create a dynamic helper
			return getOrCreateDynamicHelper(name);
		},

		// ════════════════════════════════════════════════════════════════════
		// EXISTENCE & ENUMERATION
		// ════════════════════════════════════════════════════════════════════

		/**
		 * Check if a table has any data in YJS storage.
		 *
		 * For defined tables, checks if the table's Y.Array has any rows.
		 * For dynamic tables, also checks if the Y.Array has any rows.
		 *
		 * Note: This checks for *data*, not just existence. An empty table
		 * returns false even if it was previously used.
		 *
		 * @example
		 * ```typescript
		 * if (tables.has('custom')) {
		 *   // Table has data, safe to read
		 *   const rows = tables.get('custom').getAll()
		 * }
		 * ```
		 */
		has(name: string): boolean {
			// Check defined tables first
			if (name in tableHelpers) {
				return tableHelpers[name as keyof typeof tableHelpers].count() > 0;
			}
			// Check dynamic tables - peek at the Y.Array without creating a helper
			const yarray = ydoc.getArray(`table:${name}`);
			return yarray.length > 0;
		},

		/**
		 * Get all table names that have data in YJS storage.
		 *
		 * Returns names of defined tables that have at least one row,
		 * plus any dynamic tables that have been accessed and have data.
		 *
		 * Note: This only includes tables with data. Empty tables are not returned.
		 * Dynamic tables are only tracked after being accessed via `tables.get()`.
		 *
		 * @example
		 * ```typescript
		 * tables.names()  // ['posts', 'users'] - only tables with data
		 * ```
		 */
		names(): string[] {
			const names: string[] = [];

			// Check defined tables
			for (const tableDef of tableDefinitions) {
				if (
					tableHelpers[tableDef.id as keyof typeof tableHelpers].count() > 0
				) {
					names.push(tableDef.id);
				}
			}

			// Check dynamic tables that have been accessed
			for (const [name, helper] of dynamicTableHelpers) {
				if (helper.count() > 0) {
					names.push(name);
				}
			}

			return names;
		},

		// ════════════════════════════════════════════════════════════════════
		// BULK OPERATIONS
		// ════════════════════════════════════════════════════════════════════

		/**
		 * Clear all rows in defined tables.
		 *
		 * Only clears tables that are in the workspace definition.
		 * Does not affect dynamically-created tables.
		 */
		clear(): void {
			ydoc.transact(() => {
				for (const tableDef of tableDefinitions) {
					tableHelpers[tableDef.id as keyof typeof tableHelpers].clear();
				}
			});
		},

		// ════════════════════════════════════════════════════════════════════
		// METADATA & ESCAPE HATCHES
		// ════════════════════════════════════════════════════════════════════

		/**
		 * The raw table definitions passed to createTables.
		 *
		 * Provides access to the table definitions including metadata
		 * (name, icon, description) and field schemas.
		 *
		 * @example
		 * ```typescript
		 * tables.definitions.posts.fields  // { id: {...}, title: {...} }
		 * ```
		 */
		definitions: tableDefinitions,

		// ════════════════════════════════════════════════════════════════════
		// UTILITIES
		// ════════════════════════════════════════════════════════════════════

		/**
		 * Serialize all tables to JSON.
		 *
		 * Returns an object where keys are table names and values are arrays
		 * of rows (as plain objects). Includes defined tables and any dynamic
		 * tables that have been accessed.
		 *
		 * @example
		 * ```typescript
		 * const data = tables.toJSON();
		 * // { posts: [{ id: '1', title: 'Hello' }], users: [...] }
		 * ```
		 */
		toJSON(): Record<string, unknown[]> {
			const result: Record<string, unknown[]> = {};

			// Serialize defined tables
			for (const tableDef of tableDefinitions) {
				const helper = tableHelpers[tableDef.id as keyof typeof tableHelpers];
				const rows = helper.getAllValid();
				if (rows.length > 0) {
					result[tableDef.id] = rows;
				}
			}

			// Serialize dynamic tables that have been accessed
			for (const [name, helper] of dynamicTableHelpers) {
				const rows = helper.getAllValid();
				if (rows.length > 0) {
					result[name] = rows;
				}
			}

			return result;
		},
	} as TablesFunction<TTableDefinitions>;
}

/**
 * Type alias for the return type of createTables.
 * Useful for typing function parameters that accept a tables instance.
 */
export type Tables<TTableDefinitions extends readonly TableDefinition[]> =
	ReturnType<typeof createTables<TTableDefinitions>>;
