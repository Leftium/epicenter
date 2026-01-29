import * as Y from 'yjs';
import type {
	DefinitionYMap,
	WorkspaceDefinitionMap,
} from '../docs/workspace-doc';
import type { Field, Icon, KvField, TableDefinition } from '../schema';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * KV entry definition with metadata for UI display.
 * This is an inline replacement for the deprecated KvDefinition type.
 */
type KvEntryDefinition = {
	/** Display name shown in UI (e.g., "Theme") */
	name: string;
	/** Icon for this KV entry - tagged string format 'type:value' or null */
	icon: Icon | null;
	/** Description shown in tooltips/docs */
	description: string;
	/** The field schema for this KV entry */
	field: KvField;
};

/** Y.Map storing table definitions, keyed by table name. */
export type TablesDefinitionMap = Y.Map<Y.Map<unknown>>;

/** Y.Map storing KV definitions, keyed by key name. */
export type KvDefinitionYMap = Y.Map<Y.Map<unknown>>;

/** Y.Map storing fields for a single table, keyed by field id. */
export type FieldsMap = Y.Map<Field>;

/**
 * Convert a fields Y.Map to an array.
 * The Y.Map stores fields keyed by id; this returns them as Field[].
 */
function fieldsMapToArray(fieldsMap: Y.Map<Field> | null | undefined): Field[] {
	if (!fieldsMap) return [];
	return Array.from(fieldsMap.values());
}

/** Change action for collection observation. */
export type ChangeAction = 'add' | 'delete';

/** Change action for field observation (fields can be updated). */
export type FieldChangeAction = 'add' | 'update' | 'delete';

// ─────────────────────────────────────────────────────────────────────────────
// Fields Collection (collection-style, not callable)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Collection for fields within a table.
 *
 * Uses collection-style API: `.get(key)`, `.set(key, value)`, `.delete(key)`, etc.
 * Fields are leaf nodes, so no per-field helpers are needed.
 *
 * @example
 * ```typescript
 * // Get a field
 * const titleField = table.fields.get('title');
 *
 * // Check if field exists
 * if (table.fields.has('title')) { ... }
 *
 * // Iterate over fields
 * for (const [name, field] of table.fields.entries()) { ... }
 *
 * // Modify fields
 * table.fields.set('dueDate', date());
 * table.fields.delete('legacyField');
 * ```
 */
export type FieldsCollection = {
	/** Get a field by name. */
	get(fieldName: string): Field | undefined;
	/** Check if a field exists. */
	has(fieldName: string): boolean;
	/** Get all fields as a plain object. */
	toJSON(): Record<string, Field>;
	/** Get all field names. */
	keys(): string[];
	/** Get all fields as [name, field] pairs. */
	entries(): [string, Field][];
	/** Set (add or update) a field. */
	set(fieldName: string, field: Field): void;
	/** Delete a field. Returns true if deleted. */
	delete(fieldName: string): boolean;
	/** Observe changes to fields (add/update/delete). */
	observe(
		callback: (changes: Map<string, FieldChangeAction>) => void,
	): () => void;
};

function createFieldsCollection(
	tableDefinitionMap: Y.Map<unknown>,
): FieldsCollection {
	const getFieldsMap = (): FieldsMap | null => {
		return (tableDefinitionMap.get('fields') as FieldsMap) ?? null;
	};

	const getOrCreateFieldsMap = (): FieldsMap => {
		let fieldsMap = tableDefinitionMap.get('fields') as FieldsMap | undefined;
		if (!fieldsMap) {
			fieldsMap = new Y.Map() as FieldsMap;
			tableDefinitionMap.set('fields', fieldsMap);
		}
		return fieldsMap;
	};

	return {
		get(fieldName) {
			return getFieldsMap()?.get(fieldName);
		},

		has(fieldName) {
			return getFieldsMap()?.has(fieldName) ?? false;
		},

		toJSON() {
			const fieldsMap = getFieldsMap();
			if (!fieldsMap) return {};
			return fieldsMap.toJSON() as Record<string, Field>;
		},

		keys() {
			const fieldsMap = getFieldsMap();
			if (!fieldsMap) return [];
			return Array.from(fieldsMap.keys());
		},

		entries() {
			const fieldsMap = getFieldsMap();
			if (!fieldsMap) return [];
			return Array.from(fieldsMap.entries());
		},

		set(fieldName, field) {
			getOrCreateFieldsMap().set(fieldName, field);
		},

		delete(fieldName) {
			const fieldsMap = getFieldsMap();
			if (!fieldsMap || !fieldsMap.has(fieldName)) return false;
			fieldsMap.delete(fieldName);
			return true;
		},

		observe(callback) {
			const handler = (event: Y.YMapEvent<Field>) => {
				const changes = new Map<string, FieldChangeAction>();
				event.changes.keys.forEach((change, key) => {
					changes.set(key, change.action);
				});
				if (changes.size > 0) callback(changes);
			};

			const fieldsMap = getOrCreateFieldsMap();
			fieldsMap.observe(handler);
			return () => fieldsMap.unobserve(handler);
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Table Helper (per-table operations)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Helper for a single table's definition.
 *
 * Fixed keys (name, icon, description) are property getters with `setX()` methods.
 * Dynamic keys (fields) use collection-style API.
 *
 * @example
 * ```typescript
 * const posts = definition.tables.get('posts');
 * if (posts) {
 *   // Read fixed properties
 *   console.log(posts.name);        // 'Posts'
 *   console.log(posts.icon);        // 'emoji:📝'
 *
 *   // Update fixed properties
 *   posts.setName('Blog Posts');
 *   posts.setIcon('emoji:✍️');
 *
 *   // Access fields (collection-style)
 *   const titleSchema = posts.fields.get('title');
 *   posts.fields.set('dueDate', date());
 *   posts.fields.delete('legacyField');
 * }
 * ```
 */
export type TableHelper = {
	/** Table name (display name, not the key). */
	readonly name: string;
	/** Table icon (tagged string format: 'emoji:📝', 'lucide:file', 'url:...'). */
	readonly icon: Icon | null;
	/** Table description. */
	readonly description: string;

	/** Set the table name. */
	setName(name: string): void;
	/** Set the table icon. */
	setIcon(icon: Icon | null): void;
	/** Set the table description. */
	setDescription(description: string): void;

	/** Get the full table definition as JSON. */
	toJSON(): TableDefinition;
	/** Replace the entire table definition. */
	set(definition: TableDefinition): void;
	/** Delete this table. Returns true if deleted. */
	delete(): boolean;
	/** Observe changes to this table (any nested change). */
	observe(callback: () => void): () => void;

	/** Field operations (collection-style). */
	fields: FieldsCollection;
};

function createTableHelper(
	tablesMap: TablesDefinitionMap,
	tableDefinitionMap: Y.Map<unknown>,
	tableName: string,
): TableHelper {
	return {
		// Property getters for fixed keys
		get name() {
			return (tableDefinitionMap.get('name') as string) ?? '';
		},
		get icon() {
			return (tableDefinitionMap.get('icon') as Icon | null) ?? null;
		},
		get description() {
			return (tableDefinitionMap.get('description') as string) ?? '';
		},

		// Setters for fixed keys
		setName(name) {
			tableDefinitionMap.set('name', name);
		},
		setIcon(icon) {
			tableDefinitionMap.set('icon', icon);
		},
		setDescription(description) {
			tableDefinitionMap.set('description', description);
		},

		toJSON() {
			return {
				id: tableName,
				name: (tableDefinitionMap.get('name') as string) ?? '',
				icon: (tableDefinitionMap.get('icon') as Icon | null) ?? null,
				description: (tableDefinitionMap.get('description') as string) ?? '',
				fields: fieldsMapToArray(
					tableDefinitionMap.get('fields') as Y.Map<Field>,
				),
			} as TableDefinition;
		},

		set(definition) {
			tableDefinitionMap.set('name', definition.name);
			tableDefinitionMap.set('icon', definition.icon);
			tableDefinitionMap.set('description', definition.description);

			let fieldsMap = tableDefinitionMap.get('fields') as FieldsMap | undefined;
			if (!fieldsMap) {
				fieldsMap = new Y.Map() as FieldsMap;
				tableDefinitionMap.set('fields', fieldsMap);
			}

			fieldsMap.clear();
			// Fields is an array; use field.id as the key
			for (const field of definition.fields) {
				fieldsMap.set(field.id, field);
			}
		},

		delete() {
			if (!tablesMap.has(tableName)) return false;
			tablesMap.delete(tableName);
			return true;
		},

		observe(callback) {
			tableDefinitionMap.observeDeep(callback);
			return () => tableDefinitionMap.unobserveDeep(callback);
		},

		fields: createFieldsCollection(tableDefinitionMap),
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Tables Collection (callable with properties)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Collection for table definitions.
 *
 * Use `.get(tableName)` to get a TableHelper for nested operations.
 * Use collection methods for bulk operations or snapshots.
 *
 * @example
 * ```typescript
 * // Get a table helper (for nested access)
 * const posts = definition.tables.get('posts');
 *
 * // Bulk operations
 * definition.tables.toJSON();           // all tables as JSON
 * definition.tables.keys();             // ['posts', 'users', ...]
 * definition.tables.entries();          // [[name, def], ...]
 * definition.tables.set('tasks', table('tasks', { ... }));
 * definition.tables.delete('oldTable');
 * ```
 */
export type TablesCollection = {
	/** Get a table helper for nested operations. */
	get(tableName: string): TableHelper | undefined;
	/** Check if a table exists. */
	has(tableName: string): boolean;
	/** Get all tables as a plain object. */
	toJSON(): Record<string, TableDefinition>;
	/** Get all table names. */
	keys(): string[];
	/** Get all tables as [name, definition] pairs. */
	entries(): [string, TableDefinition][];
	/** Set (add or update) a table definition. */
	set(tableName: string, definition: TableDefinition<readonly Field[]>): void;
	/** Delete a table. Returns true if deleted. */
	delete(tableName: string): boolean;
	/** Observe changes to tables (add/delete). */
	observe(callback: (changes: Map<string, ChangeAction>) => void): () => void;
};

function createTablesCollection(
	definitionMap: DefinitionYMap,
): TablesCollection {
	const getTablesMap = (): TablesDefinitionMap | null => {
		return (definitionMap.get('tables') as TablesDefinitionMap) ?? null;
	};

	const getOrCreateTablesMap = (): TablesDefinitionMap => {
		let tablesMap = definitionMap.get('tables') as
			| TablesDefinitionMap
			| undefined;
		if (!tablesMap) {
			tablesMap = new Y.Map() as TablesDefinitionMap;
			definitionMap.set('tables', tablesMap);
		}
		return tablesMap;
	};

	const tableHelperCache = new Map<string, TableHelper>();

	return {
		get(tableName: string): TableHelper | undefined {
			const tablesMap = getTablesMap();
			if (!tablesMap) return undefined;

			const tableDefinitionMap = tablesMap.get(tableName);
			if (!tableDefinitionMap) return undefined;

			let helper = tableHelperCache.get(tableName);
			if (!helper) {
				helper = createTableHelper(tablesMap, tableDefinitionMap, tableName);
				tableHelperCache.set(tableName, helper);
			}
			return helper;
		},

		has(tableName: string) {
			return getTablesMap()?.has(tableName) ?? false;
		},

		toJSON(): Record<string, TableDefinition> {
			const tablesMap = getTablesMap();
			if (!tablesMap) return {};

			const result: Record<string, TableDefinition> = {};
			for (const [tableName, tableDefinitionMap] of tablesMap.entries()) {
				result[tableName] = {
					id: tableName,
					name: (tableDefinitionMap.get('name') as string) ?? '',
					icon: (tableDefinitionMap.get('icon') as Icon | null) ?? null,
					description: (tableDefinitionMap.get('description') as string) ?? '',
					fields: fieldsMapToArray(
						tableDefinitionMap.get('fields') as Y.Map<Field>,
					),
				} as TableDefinition;
			}
			return result;
		},

		keys(): string[] {
			const tablesMap = getTablesMap();
			if (!tablesMap) return [];
			return Array.from(tablesMap.keys());
		},

		entries(): [string, TableDefinition][] {
			const tablesMap = getTablesMap();
			if (!tablesMap) return [];

			const result: [string, TableDefinition][] = [];
			for (const [tableName, tableDefinitionMap] of tablesMap.entries()) {
				result.push([
					tableName,
					{
						id: tableName,
						name: (tableDefinitionMap.get('name') as string) ?? '',
						icon: (tableDefinitionMap.get('icon') as Icon | null) ?? null,
						description:
							(tableDefinitionMap.get('description') as string) ?? '',
						fields: fieldsMapToArray(
							tableDefinitionMap.get('fields') as Y.Map<Field>,
						),
					} as TableDefinition,
				]);
			}
			return result;
		},

		set(
			tableName: string,
			definition: TableDefinition<readonly Field[]>,
		): void {
			const tablesMap = getOrCreateTablesMap();

			let tableDefinitionMap = tablesMap.get(tableName);
			if (!tableDefinitionMap) {
				tableDefinitionMap = new Y.Map();
				tablesMap.set(tableName, tableDefinitionMap);
			}

			tableDefinitionMap.set('name', definition.name);
			tableDefinitionMap.set('icon', definition.icon);
			tableDefinitionMap.set('description', definition.description);

			let fieldsMap = tableDefinitionMap.get('fields') as FieldsMap | undefined;
			if (!fieldsMap) {
				fieldsMap = new Y.Map() as FieldsMap;
				tableDefinitionMap.set('fields', fieldsMap);
			}

			// Fields is an array; use field.id as the key
			for (const field of definition.fields) {
				fieldsMap.set(field.id, field);
			}

			tableHelperCache.delete(tableName);
		},

		delete(tableName: string): boolean {
			const tablesMap = getTablesMap();
			if (!tablesMap || !tablesMap.has(tableName)) return false;
			tablesMap.delete(tableName);
			tableHelperCache.delete(tableName);
			return true;
		},

		observe(
			callback: (changes: Map<string, ChangeAction>) => void,
		): () => void {
			const handler = (event: Y.YMapEvent<Y.Map<unknown>>) => {
				const changes = new Map<string, ChangeAction>();
				event.changes.keys.forEach((change, key) => {
					if (change.action === 'add' || change.action === 'delete') {
						changes.set(key, change.action);
					}
				});
				if (changes.size > 0) callback(changes);
			};

			const tablesMap = getOrCreateTablesMap();
			tablesMap.observe(handler);
			return () => tablesMap.unobserve(handler);
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// KV Helper (per-key operations)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Helper for a single KV definition.
 *
 * Fixed keys (name, icon, description, field) are property getters with `setX()` methods.
 *
 * @example
 * ```typescript
 * const theme = definition.kv.get('theme');
 * if (theme) {
 *   // Read properties
 *   console.log(theme.name);        // 'Theme'
 *   console.log(theme.field);       // { type: 'select', options: [...] }
 *
 *   // Update properties
 *   theme.setName('Color Theme');
 *   theme.setField(select({ options: ['light', 'dark', 'auto'] }));
 * }
 * ```
 */
export type KvHelper = {
	/** KV display name. */
	readonly name: string;
	/** KV icon (tagged string format: 'emoji:🎨', 'lucide:settings', 'url:...'). */
	readonly icon: Icon | null;
	/** KV description. */
	readonly description: string;
	/** KV field. */
	readonly field: KvField;

	/** Set the KV name. */
	setName(name: string): void;
	/** Set the KV icon. */
	setIcon(icon: Icon | null): void;
	/** Set the KV description. */
	setDescription(description: string): void;
	/** Set the KV field. */
	setField(field: KvField): void;

	/** Get the full KV definition as JSON. */
	toJSON(): KvEntryDefinition;
	/** Replace the entire KV definition. */
	set(definition: KvEntryDefinition): void;
	/** Delete this KV entry. Returns true if deleted. */
	delete(): boolean;
	/** Observe changes to this KV entry. */
	observe(callback: (definition: KvEntryDefinition) => void): () => void;
};

function createKvHelper(
	kvMap: KvDefinitionYMap,
	kvEntryMap: Y.Map<unknown>,
	keyName: string,
): KvHelper {
	return {
		// Property getters
		get name() {
			return (kvEntryMap.get('name') as string) ?? '';
		},
		get icon() {
			return (kvEntryMap.get('icon') as Icon | null) ?? null;
		},
		get description() {
			return (kvEntryMap.get('description') as string) ?? '';
		},
		get field() {
			return kvEntryMap.get('field') as KvField;
		},

		// Setters
		setName(name) {
			kvEntryMap.set('name', name);
		},
		setIcon(icon) {
			kvEntryMap.set('icon', icon);
		},
		setDescription(description) {
			kvEntryMap.set('description', description);
		},
		setField(field) {
			kvEntryMap.set('field', field);
		},

		toJSON() {
			return {
				name: (kvEntryMap.get('name') as string) ?? '',
				icon: (kvEntryMap.get('icon') as Icon | null) ?? null,
				description: (kvEntryMap.get('description') as string) ?? '',
				field: kvEntryMap.get('field'),
			} as KvEntryDefinition;
		},

		set(definition) {
			kvEntryMap.set('name', definition.name);
			kvEntryMap.set('icon', definition.icon);
			kvEntryMap.set('description', definition.description);
			kvEntryMap.set('field', definition.field);
		},

		delete() {
			if (!kvMap.has(keyName)) return false;
			kvMap.delete(keyName);
			return true;
		},

		observe(callback) {
			const handler = () => {
				callback(this.toJSON());
			};
			kvEntryMap.observeDeep(handler);
			return () => kvEntryMap.unobserveDeep(handler);
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// KV Collection (callable with properties)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Collection for KV definitions.
 *
 * @example
 * ```typescript
 * // Get a KV helper for nested operations
 * const theme = definition.kv.get('theme');
 *
 * // Bulk operations
 * definition.kv.toJSON();
 * definition.kv.keys();
 * definition.kv.set('count', setting({ ... }));
 * ```
 */
export type KvCollection = {
	/** Get a KV helper for nested operations. */
	get(keyName: string): KvHelper | undefined;
	/** Check if a KV entry exists. */
	has(keyName: string): boolean;
	/** Get all KV definitions as a plain object. */
	toJSON(): Record<string, KvEntryDefinition>;
	/** Get all KV key names. */
	keys(): string[];
	/** Get all KV entries as [name, definition] pairs. */
	entries(): [string, KvEntryDefinition][];
	/** Set (add or update) a KV definition. */
	set(keyName: string, definition: KvEntryDefinition): void;
	/** Delete a KV entry. Returns true if deleted. */
	delete(keyName: string): boolean;
	/** Observe changes to KV entries (add/delete). */
	observe(callback: (changes: Map<string, ChangeAction>) => void): () => void;
};

function createKvCollection(definitionMap: DefinitionYMap): KvCollection {
	const getKvMap = (): KvDefinitionYMap | null => {
		return (definitionMap.get('kv') as KvDefinitionYMap) ?? null;
	};

	const getOrCreateKvMap = (): KvDefinitionYMap => {
		let kvMap = definitionMap.get('kv') as KvDefinitionYMap | undefined;
		if (!kvMap) {
			kvMap = new Y.Map() as KvDefinitionYMap;
			definitionMap.set('kv', kvMap);
		}
		return kvMap;
	};

	const kvHelperCache = new Map<string, KvHelper>();

	return {
		get(keyName: string): KvHelper | undefined {
			const kvMap = getKvMap();
			if (!kvMap) return undefined;

			const kvEntryMap = kvMap.get(keyName);
			if (!kvEntryMap) return undefined;

			let helper = kvHelperCache.get(keyName);
			if (!helper) {
				helper = createKvHelper(kvMap, kvEntryMap, keyName);
				kvHelperCache.set(keyName, helper);
			}
			return helper;
		},

		has(keyName: string) {
			return getKvMap()?.has(keyName) ?? false;
		},

		toJSON(): Record<string, KvEntryDefinition> {
			const kvMap = getKvMap();
			if (!kvMap) return {};

			const result: Record<string, KvEntryDefinition> = {};
			for (const [keyName, kvEntryMap] of kvMap.entries()) {
				result[keyName] = {
					name: (kvEntryMap.get('name') as string) ?? '',
					icon: (kvEntryMap.get('icon') as Icon | null) ?? null,
					description: (kvEntryMap.get('description') as string) ?? '',
					field: kvEntryMap.get('field'),
				} as KvEntryDefinition;
			}
			return result;
		},

		keys(): string[] {
			const kvMap = getKvMap();
			if (!kvMap) return [];
			return Array.from(kvMap.keys());
		},

		entries(): [string, KvEntryDefinition][] {
			const kvMap = getKvMap();
			if (!kvMap) return [];

			const result: [string, KvEntryDefinition][] = [];
			for (const [keyName, kvEntryMap] of kvMap.entries()) {
				result.push([
					keyName,
					{
						name: (kvEntryMap.get('name') as string) ?? '',
						icon: (kvEntryMap.get('icon') as Icon | null) ?? null,
						description: (kvEntryMap.get('description') as string) ?? '',
						field: kvEntryMap.get('field'),
					} as KvEntryDefinition,
				]);
			}
			return result;
		},

		set(keyName: string, definition: KvEntryDefinition): void {
			const kvMap = getOrCreateKvMap();

			let kvEntryMap = kvMap.get(keyName);
			if (!kvEntryMap) {
				kvEntryMap = new Y.Map();
				kvMap.set(keyName, kvEntryMap);
			}

			kvEntryMap.set('name', definition.name);
			kvEntryMap.set('icon', definition.icon);
			kvEntryMap.set('description', definition.description);
			kvEntryMap.set('field', definition.field);

			kvHelperCache.delete(keyName);
		},

		delete(keyName: string): boolean {
			const kvMap = getKvMap();
			if (!kvMap || !kvMap.has(keyName)) return false;
			kvMap.delete(keyName);
			kvHelperCache.delete(keyName);
			return true;
		},

		observe(
			callback: (changes: Map<string, ChangeAction>) => void,
		): () => void {
			const handler = (event: Y.YMapEvent<Y.Map<unknown>>) => {
				const changes = new Map<string, ChangeAction>();
				event.changes.keys.forEach((change, key) => {
					if (change.action === 'add' || change.action === 'delete') {
						changes.set(key, change.action);
					}
				});
				if (changes.size > 0) callback(changes);
			};

			const kvMap = getOrCreateKvMap();
			kvMap.observe(handler);
			return () => kvMap.unobserve(handler);
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Definition Helper (main export)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Definition helper for managing workspace table and KV definitions.
 *
 * ## Design Principles
 *
 * 1. **`.get()` for dynamic keys**: `tables.get('posts')` returns a helper for nested access
 * 2. **Collection methods for bulk ops**: `tables.toJSON()`, `tables.entries()`, `tables.keys()`
 * 3. **Property getters for fixed keys**: `table.name`, `table.icon` (not methods)
 * 4. **Asymmetric setters**: `table.setName()`, `table.setIcon()` (explicit mutation)
 *
 * ## API Overview
 *
 * ```
 * definition
 * ├── .toJSON()                       → WorkspaceDefinitionMap
 * ├── .merge({ tables?, kv? })        → void
 * ├── .observe(cb)                    → unsubscribe
 * │
 * ├── .tables(name)                   → TableHelper | undefined
 * ├── .tables.get(name)               → TableDefinition | undefined
 * ├── .tables.has(name)               → boolean
 * ├── .tables.toJSON()                → Record<string, TableDefinition>
 * ├── .tables.keys()                  → string[]
 * ├── .tables.entries()               → [string, TableDefinition][]
 * ├── .tables.set(name, def)          → void
 * ├── .tables.delete(name)            → boolean
 * └── .tables.observe(cb)             → unsubscribe
 *
 * definition.tables.get('posts')      → TableHelper
 * ├── .name                           → string (getter)
 * ├── .icon                           → Icon | null (getter)
 * ├── .description                    → string (getter)
 * ├── .setName(v)                     → void
 * ├── .setIcon(v)                     → void
 * ├── .setDescription(v)              → void
 * ├── .toJSON()                       → TableDefinition
 * ├── .set(def)                       → void
 * ├── .delete()                       → boolean
 * ├── .observe(cb)                    → unsubscribe
 * └── .fields                         → FieldsCollection
 *     ├── .get(name)                  → Field | undefined
 *     ├── .has(name)                  → boolean
 *     ├── .toJSON()                   → Record<string, Field>
 *     ├── .keys()                     → string[]
 *     ├── .entries()                  → [string, Field][]
 *     ├── .set(name, field)           → void
 *     ├── .delete(name)               → boolean
 *     └── .observe(cb)                → unsubscribe
 * ```
 */
export function createDefinition(definitionMap: DefinitionYMap) {
	const tables = createTablesCollection(definitionMap);
	const kv = createKvCollection(definitionMap);

	return {
		/**
		 * Serialize the entire definition to a plain JSON object.
		 */
		toJSON(): WorkspaceDefinitionMap {
			return definitionMap.toJSON() as WorkspaceDefinitionMap;
		},

		/**
		 * Merge definitions into the workspace.
		 * Existing definitions not in the payload are preserved.
		 */
		merge(input: {
			tables: Record<string, TableDefinition>;
			kv: Record<string, KvEntryDefinition>;
		}): void {
			for (const [tableName, tableDefinition] of Object.entries(input.tables)) {
				tables.set(tableName, tableDefinition);
			}
			for (const [keyName, kvDefinition] of Object.entries(input.kv)) {
				kv.set(keyName, kvDefinition);
			}
		},

		/**
		 * Observe any definition changes (tables or KV).
		 * Uses observeDeep to catch all nested changes.
		 */
		observe(callback: () => void): () => void {
			definitionMap.observeDeep(callback);
			return () => definitionMap.unobserveDeep(callback);
		},

		/** Table definition operations. */
		tables,

		/** KV definition operations. */
		kv,
	};
}

export type Definition = ReturnType<typeof createDefinition>;
