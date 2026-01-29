/**
 * @fileoverview Core field type definitions
 *
 * Contains the foundational types for the schema system:
 * - Field types (IdFieldSchema, TextFieldSchema, etc.)
 * - Table and workspace schemas
 * - Row value types (CellValue, Row, PartialRow)
 *
 * ## Field Structure
 *
 * Each field is a minimal object with `type` as the discriminant:
 * - `type`: Field type ('text', 'select', 'tags', etc.)
 * - `nullable`: Optional boolean for nullability
 * - Type-specific fields (e.g., `options` for select/tags)
 *
 * This is a Notion-like format optimized for user configuration and storage.
 * JSON Schema can be derived on-demand for MCP/OpenAPI export.
 *
 * ## Nullability
 *
 * Nullability is encoded in a simple boolean `nullable` field:
 * - Non-nullable: `nullable` omitted or `false`
 * - Nullable: `nullable: true`
 *
 * Special cases:
 * - `id`: Never nullable (implicit)
 * - `richtext`: Always nullable (implicit)
 *
 * ## Related Files
 *
 * - `factories.ts` - Factory functions for creating fields
 * - `../converters/` - Converters for arktype, drizzle, typebox
 * - `helpers.ts` - isNullableField helper
 */

import type { Static, TSchema } from 'typebox';
import type { DateTimeString } from './datetime';

// ============================================================================
// Icon Type (Tagged String)
// ============================================================================

/**
 * Icon as a tagged string format: `{type}:{value}`
 *
 * Uses template literal types for compile-time safety. Tagged strings are
 * LWW-safe in YJS (concurrent edits produce valid icons) and require no
 * encode/decode layer.
 *
 * @example
 * ```typescript
 * // Emoji icon
 * const icon: Icon = 'emoji:📝';
 *
 * // Lucide icon
 * const icon: Icon = 'lucide:file-text';
 *
 * // External URL
 * const icon: Icon = 'url:https://example.com/icon.png';
 *
 * // Parsing when needed
 * const [type, value] = icon.split(':') as [IconType, string];
 * ```
 */
export type Icon = `emoji:${string}` | `lucide:${string}` | `url:${string}`;

/**
 * Icon type discriminator.
 */
export type IconType = 'emoji' | 'lucide' | 'url';

/**
 * Parse an Icon tagged string into its components.
 *
 * @example
 * ```typescript
 * const { type, value } = parseIcon('emoji:📝');
 * // type: 'emoji', value: '📝'
 * ```
 */
export function parseIcon(icon: Icon): { type: IconType; value: string } {
	const colonIndex = icon.indexOf(':');
	return {
		type: icon.slice(0, colonIndex) as IconType,
		value: icon.slice(colonIndex + 1),
	};
}

/**
 * Create an Icon tagged string from type and value.
 *
 * @example
 * ```typescript
 * const icon = createIcon('emoji', '📝'); // 'emoji:📝'
 * ```
 */
export function createIcon(type: IconType, value: string): Icon {
	return `${type}:${value}` as Icon;
}

/**
 * Check if a string is a valid Icon format.
 */
export function isIcon(value: string): value is Icon {
	return (
		value.startsWith('emoji:') ||
		value.startsWith('lucide:') ||
		value.startsWith('url:')
	);
}

// ============================================================================
// Field Metadata
// ============================================================================

/**
 * Metadata for individual fields (columns) in a table.
 *
 * Every field schema includes these properties for Notion-like UI display,
 * where each column can have its own display name, icon, and description.
 * Factory functions provide sensible defaults (empty string, null icon).
 *
 * The `id` is included here because every field must have an identifier -
 * it's as fundamental to a field's identity as its name.
 *
 * ```
 * TableDefinition
 * ├── name, icon, description    ← TableMetadata (table-level)
 * └── fields
 *     ├── { id: "id", ... }
 *     │   ├── id, name, icon, description  ← FieldMetadata (column-level)
 *     │   └── type: "id"
 *     └── { id: "title", ... }
 *         ├── id, name, icon, description  ← FieldMetadata (column-level)
 *         ├── type: "text"
 *         └── nullable: false
 * ```
 *
 * @example
 * ```typescript
 * // Field with custom metadata
 * const titleField = text('title', {
 *   name: 'Post Title',
 *   icon: 'emoji:📝',
 *   description: 'The main title displayed on the blog',
 * });
 *
 * // Field with defaults (name: '', icon: null, description: '')
 * const simpleField = text('title');
 * ```
 */
export type FieldMetadata = {
	/** Unique identifier for the field within its table. */
	id: string;
	/** Display name shown in UI. Empty string if not provided. */
	name: string;
	/** Description shown in tooltips/docs. Empty string if not provided. */
	description: string;
	/** Icon for the field - tagged string format 'type:value'. */
	icon: Icon | null;
};

/**
 * Options for field factory functions.
 * All metadata fields are optional; factories provide defaults.
 */
export type FieldOptions = {
	/** Display name shown in UI. Defaults to empty string. */
	name?: string;
	/** Description shown in tooltips/docs. Defaults to empty string. */
	description?: string;
	/** Icon for the field - tagged string format 'type:value'. Defaults to null. */
	icon?: Icon | null;
};

// ============================================================================
// Field Types (with id included)
// ============================================================================

/**
 * ID field - auto-generated primary key.
 * Always NOT NULL (implicit, no nullable field needed).
 */
export type IdField = FieldMetadata & {
	type: 'id';
};

/**
 * Text field - single-line string input.
 */
export type TextField<TNullable extends boolean = boolean> = FieldMetadata & {
	type: 'text';
	nullable?: TNullable;
	default?: string;
};

/**
 * Rich text reference field - stores ID pointing to separate rich content document.
 * The ID references a separate Y.Doc for collaborative editing.
 * The row itself just stores the string ID (JSON-serializable).
 *
 * Always nullable - Y.Docs are created lazily when user first edits.
 * No need to specify nullable or default; they're implicit.
 */
export type RichtextField = FieldMetadata & {
	type: 'richtext';
};

/**
 * Integer field - whole numbers.
 */
export type IntegerField<TNullable extends boolean = boolean> =
	FieldMetadata & {
		type: 'integer';
		nullable?: TNullable;
		default?: number;
	};

/**
 * Real/float field - decimal numbers.
 */
export type RealField<TNullable extends boolean = boolean> = FieldMetadata & {
	type: 'real';
	nullable?: TNullable;
	default?: number;
};

/**
 * Boolean field - true/false values.
 */
export type BooleanField<TNullable extends boolean = boolean> =
	FieldMetadata & {
		type: 'boolean';
		nullable?: TNullable;
		default?: boolean;
	};

/**
 * Date field - timezone-aware dates.
 * Stored as DateTimeString format: `{iso}|{timezone}`.
 */
export type DateField<TNullable extends boolean = boolean> = FieldMetadata & {
	type: 'date';
	nullable?: TNullable;
	default?: DateTimeString;
};

/**
 * Select field - single choice from predefined options.
 *
 * @example
 * ```typescript
 * {
 *   id: 'status',
 *   type: 'select',
 *   options: ['draft', 'published', 'archived'],
 *   default: 'draft'
 * }
 * ```
 */
export type SelectField<
	TOptions extends readonly [string, ...string[]] = readonly [
		string,
		...string[],
	],
	TNullable extends boolean = boolean,
> = FieldMetadata & {
	type: 'select';
	options: TOptions;
	nullable?: TNullable;
	default?: TOptions[number];
};

/**
 * Tags field - array of strings with optional validation.
 * Stored as plain arrays (JSON-serializable).
 *
 * Two modes:
 * - With `options`: Only values from options are allowed
 * - Without `options`: Any string array is allowed
 *
 * @example
 * ```typescript
 * // Validated tags
 * { id: 'priority', type: 'tags', options: ['urgent', 'normal', 'low'] }
 *
 * // Unconstrained tags
 * { id: 'labels', type: 'tags' }
 * ```
 */
export type TagsField<
	TOptions extends readonly [string, ...string[]] = readonly [
		string,
		...string[],
	],
	TNullable extends boolean = boolean,
> = FieldMetadata & {
	type: 'tags';
	options?: TOptions;
	nullable?: TNullable;
	default?: TOptions[number][];
};

/**
 * JSON field - arbitrary JSON validated by a TypeBox schema.
 *
 * The `schema` property holds a TypeBox schema (TSchema), which IS JSON Schema.
 * TypeBox schemas are plain JSON objects that can be:
 * - Stored directly in Y.Doc (no conversion needed)
 * - Compiled to JIT validators using `Compile()` from `typebox/compile`
 * - Used for TypeScript type inference via `Static<typeof schema>`
 *
 * @example
 * ```typescript
 * import { Type } from 'typebox';
 *
 * {
 *   id: 'settings',
 *   type: 'json',
 *   schema: Type.Object({ theme: Type.String(), darkMode: Type.Boolean() }),
 *   default: { theme: 'dark', darkMode: true }
 * }
 * ```
 */
export type JsonField<
	T extends TSchema = TSchema,
	TNullable extends boolean = boolean,
> = FieldMetadata & {
	type: 'json';
	schema: T;
	nullable?: TNullable;
	default?: Static<T>;
};

// ============================================================================
// Legacy Type Aliases (for backwards compatibility)
// ============================================================================

/** @deprecated Use `IdField` instead */
export type IdFieldSchema = IdField;
/** @deprecated Use `TextField` instead */
export type TextFieldSchema<TNullable extends boolean = boolean> =
	TextField<TNullable>;
/** @deprecated Use `RichtextField` instead */
export type RichtextFieldSchema = RichtextField;
/** @deprecated Use `IntegerField` instead */
export type IntegerFieldSchema<TNullable extends boolean = boolean> =
	IntegerField<TNullable>;
/** @deprecated Use `RealField` instead */
export type RealFieldSchema<TNullable extends boolean = boolean> =
	RealField<TNullable>;
/** @deprecated Use `BooleanField` instead */
export type BooleanFieldSchema<TNullable extends boolean = boolean> =
	BooleanField<TNullable>;
/** @deprecated Use `DateField` instead */
export type DateFieldSchema<TNullable extends boolean = boolean> =
	DateField<TNullable>;
/** @deprecated Use `SelectField` instead */
export type SelectFieldSchema<
	TOptions extends readonly [string, ...string[]] = readonly [
		string,
		...string[],
	],
	TNullable extends boolean = boolean,
> = SelectField<TOptions, TNullable>;
/** @deprecated Use `TagsField` instead */
export type TagsFieldSchema<
	TOptions extends readonly [string, ...string[]] = readonly [
		string,
		...string[],
	],
	TNullable extends boolean = boolean,
> = TagsField<TOptions, TNullable>;
/** @deprecated Use `JsonField` instead */
export type JsonFieldSchema<
	T extends TSchema = TSchema,
	TNullable extends boolean = boolean,
> = JsonField<T, TNullable>;

// ============================================================================
// Discriminated Unions and Utility Types
// ============================================================================

/**
 * Discriminated union of all field types.
 * Use `type` to narrow to a specific type.
 *
 * All fields include the `id` property - it's part of the field definition itself.
 */
export type Field =
	| IdField
	| TextField
	| RichtextField
	| IntegerField
	| RealField
	| BooleanField
	| DateField
	| SelectField
	| TagsField
	| JsonField;

/**
 * @deprecated Use `Field` instead. FieldSchema is now identical to Field.
 */
export type FieldSchema = Field;

/**
 * Extract the type name from a field definition.
 * One of: 'id', 'text', 'richtext', 'integer', 'real', 'boolean', 'date', 'select', 'tags', 'json'
 */
export type FieldType = Field['type'];

// ============================================================================
// Type Utilities for Field Arrays
// ============================================================================

/**
 * Get specific field by id from array.
 */
export type FieldById<
	TFields extends readonly Field[],
	K extends string,
> = Extract<TFields[number], { id: K }>;

/**
 * Get union of all field ids from array.
 */
export type FieldIds<TFields extends readonly Field[]> = TFields[number]['id'];

// ============================================================================
// Type Utilities for Table Arrays
// ============================================================================

/**
 * Get specific table by id from array.
 *
 * @example
 * ```typescript
 * type PostsTable = TableById<typeof workspace.tables, 'posts'>;
 * ```
 */
export type TableById<
	TTables extends readonly TableDefinition[],
	K extends string,
> = Extract<TTables[number], { id: K }>;

/**
 * Get union of all table ids from array.
 *
 * @example
 * ```typescript
 * type AllTableIds = TableIds<typeof workspace.tables>; // 'posts' | 'users' | ...
 * ```
 */
export type TableIds<TTables extends readonly TableDefinition[]> =
	TTables[number]['id'];

// ============================================================================
// Type Utilities for KV Field Arrays
// ============================================================================

/**
 * Get specific KV field by id from array.
 *
 * @example
 * ```typescript
 * type ThemeField = KvFieldById<typeof workspace.kv, 'theme'>;
 * ```
 */
export type KvFieldById<
	TKv extends readonly KvField[],
	K extends string,
> = Extract<TKv[number], { id: K }>;

/**
 * Get union of all KV field ids from array.
 *
 * @example
 * ```typescript
 * type KvKeys = KvFieldIds<typeof workspace.kv>; // 'theme' | 'fontSize' | ...
 * ```
 */
export type KvFieldIds<TKv extends readonly KvField[]> = TKv[number]['id'];

// ============================================================================
// Value Types
// ============================================================================

/**
 * Helper type to check if a field definition is nullable.
 *
 * Uses optional property check `{ nullable?: true }` because field definitions
 * define `nullable?: TNullable` (optional). When `TNullable = true`, the type
 * is `nullable?: true` which doesn't extend `{ nullable: true }` (required).
 *
 * This also correctly handles RichtextField (no nullable property)
 * because optional properties can be absent.
 */
type IsNullable<C extends Field> = C extends { nullable?: true } ? true : false;

/**
 * Maps a field definition to its runtime value type.
 *
 * - RichtextField → string | null (always nullable)
 * - TagsField → string[] (plain array)
 * - DateField → DateTimeString
 * - Other fields → primitive types
 *
 * Nullability is derived from the definition's `nullable` field.
 */
export type CellValue<C extends Field = Field> = C extends IdField
	? string
	: C extends TextField
		? IsNullable<C> extends true
			? string | null
			: string
		: C extends RichtextField
			? string | null // always nullable
			: C extends IntegerField
				? IsNullable<C> extends true
					? number | null
					: number
				: C extends RealField
					? IsNullable<C> extends true
						? number | null
						: number
					: C extends BooleanField
						? IsNullable<C> extends true
							? boolean | null
							: boolean
						: C extends DateField
							? IsNullable<C> extends true
								? DateTimeString | null
								: DateTimeString
							: C extends SelectField<infer TOptions>
								? IsNullable<C> extends true
									? TOptions[number] | null
									: TOptions[number]
								: C extends TagsField<infer TOptions>
									? IsNullable<C> extends true
										? TOptions[number][] | null
										: TOptions[number][]
									: C extends JsonField<infer T extends TSchema>
										? IsNullable<C> extends true
											? Static<T> | null
											: Static<T>
										: never;

// ============================================================================
// Table Schema Types
// ============================================================================

/**
 * Table definition with metadata for UI display.
 * This is the **normalized** output type created by the `table()` factory function.
 *
 * Fields are stored as an array where array position determines display order.
 * Each field has an `id` property.
 *
 * @example
 * ```typescript
 * const postsTable = table('posts', {
 *   name: 'Posts',
 *   description: 'Blog posts and articles',
 *   icon: 'emoji:📝',
 *   fields: [
 *     id(),
 *     text('title'),
 *     select('status', { options: ['draft', 'published'] }),
 *   ],
 * });
 * // Result:
 * // {
 * //   id: 'posts',
 * //   name: 'Posts',
 * //   description: 'Blog posts and articles',
 * //   icon: 'emoji:📝',
 * //   fields: [...]
 * // }
 * ```
 */
export type TableDefinition<
	TFields extends readonly Field[] = readonly Field[],
> = {
	/** Unique identifier for this table */
	id: string;
	/** Required display name shown in UI (e.g., "Blog Posts") */
	name: string;
	/** Required description shown in tooltips/docs */
	description: string;
	/** Icon for the table - tagged string format 'type:value' or null */
	icon: Icon | null;
	/** Field definitions as array (position = display order) */
	fields: TFields;
};

/**
 * Map of table names to their full definitions (metadata + fields).
 *
 * @deprecated Use `TableDefinition[]` array instead. This type is kept for backward compatibility.
 *
 * @example
 * ```typescript
 * // Old style (deprecated)
 * const blogTables: TableDefinitionMap = {
 *   posts: table('posts', { name: 'Posts', fields: [id(), text('title')] }),
 * };
 *
 * // New style (recommended)
 * const tables = [
 *   table('posts', { name: 'Posts', fields: [id(), text('title')] }),
 * ];
 * ```
 */
export type TableDefinitionMap = Record<
	string,
	TableDefinition<readonly Field[]>
>;

// ============================================================================
// Row Types
// ============================================================================

/**
 * Plain object representing a complete table row.
 *
 * Row is the unified type for both reads and writes. All values are plain
 * JSON-serializable primitives (no Y.js types, no methods, no proxy behavior).
 *
 * @example
 * ```typescript
 * // Write: pass a Row to upsert
 * tables.get('posts').upsert({
 *   id: generateId(),
 *   title: 'Hello World',
 *   published: false,
 * });
 *
 * // Read: get returns a Row (wrapped in RowResult for validation)
 * const result = tables.get('posts').get({ id: '1' });
 * if (result.status === 'valid') {
 *   const row: Row = result.row;
 *   console.log(row.title);
 * }
 *
 * // Rows are JSON-serializable
 * const json = JSON.stringify(row);
 * ```
 */
export type Row<TFields extends readonly Field[] = readonly Field[]> = {
	[K in TFields[number]['id']]: CellValue<FieldById<TFields, K>>;
};

/**
 * Partial row for updates. ID is required, all other fields are optional.
 *
 * Use PartialRow with `update()` when you only want to change specific fields
 * without providing the entire row. Fields not included are left unchanged.
 *
 * @example
 * ```typescript
 * // Update only the title, leave other fields unchanged
 * tables.get('posts').update({ id: '1', title: 'New Title' });
 *
 * // Update multiple fields
 * tables.get('posts').update({
 *   id: '1',
 *   title: 'Updated',
 *   published: true,
 * });
 * ```
 */
export type PartialRow<TFields extends readonly Field[] = readonly Field[]> = {
	id: string;
} & Partial<Omit<Row<TFields>, 'id'>>;

// ============================================================================
// Key-Value Schema Types
// ============================================================================

/**
 * Field definition for KV stores (excludes IdField).
 * KV entries don't have row IDs; they're keyed by string.
 * The field's `id` property is used as the key in the KV store.
 */
export type KvField = Exclude<Field, IdField>;

/**
 * Runtime value type for a KV entry.
 */
export type KvValue<C extends KvField = KvField> = CellValue<C>;

/**
 * KV entry definition with metadata for UI display.
 *
 * @deprecated Use `KvField` directly. The field's metadata (name, icon, description)
 * and id property serve as the KV key. The `setting()` wrapper is no longer needed.
 *
 * @example
 * ```typescript
 * // Old style (deprecated)
 * kv: {
 *   theme: setting({ name: 'Theme', field: select('theme', { options: ['light', 'dark'] }) }),
 * }
 *
 * // New style (recommended)
 * kv: [
 *   select('theme', { name: 'Theme', options: ['light', 'dark'] }),
 * ]
 * ```
 */
export type KvDefinition<TField extends KvField = KvField> = {
	/** Display name shown in UI (e.g., "Theme") */
	name: string;
	/** Icon for this KV entry - tagged string format 'type:value' or null */
	icon: Icon | null;
	/** Description shown in tooltips/docs */
	description: string;
	/** The field schema for this KV entry */
	field: TField;
};

/**
 * Map of KV key names to their full definitions (metadata + field).
 *
 * @deprecated Use `KvField[]` (readonly array) instead. This type is kept for backward compatibility.
 *
 * @example
 * ```typescript
 * // Old style (deprecated)
 * const settingsKv: KvDefinitionMap = {
 *   theme: setting({ name: 'Theme', field: select('theme', { options: ['light', 'dark'] }) }),
 * };
 *
 * // New style (recommended)
 * const kv = [
 *   select('theme', { name: 'Theme', options: ['light', 'dark'] }),
 *   integer('fontSize', { name: 'Font Size', default: 14 }),
 * ];
 * ```
 */
export type KvDefinitionMap = Record<string, KvDefinition>;

/**
 * Map of KV keys to their field schemas (no metadata).
 *
 * @deprecated Use `KvField[]` (readonly array) instead. This type is kept for backward compatibility.
 */
export type KvMap = Record<string, KvField>;

// ============================================================================
// Array ↔ Record Conversion Utilities
// ============================================================================

/**
 * Convert a TableDefinition[] array to a Record<string, TableDefinition> map.
 *
 * Used internally when converting from array format to Record format for
 * backward compatibility with existing code.
 *
 * @example
 * ```typescript
 * const tables = [table('posts', { ... }), table('users', { ... })];
 * const map = tablesToMap(tables);
 * // { posts: { id: 'posts', ... }, users: { id: 'users', ... } }
 * ```
 */
export function tablesToMap<
	TTables extends readonly TableDefinition<readonly Field[]>[],
>(tables: TTables): { [K in TTables[number]['id']]: TableById<TTables, K> } {
	return Object.fromEntries(tables.map((t) => [t.id, t])) as {
		[K in TTables[number]['id']]: TableById<TTables, K>;
	};
}

/**
 * Convert a KvField[] array to a Record<string, { field: KvField }> map.
 *
 * Used internally when converting from array format to the legacy KvDefinitionLike format.
 * The resulting map uses the field's `id` as the key.
 *
 * @example
 * ```typescript
 * const kv = [select('theme', { options: ['light', 'dark'] }), integer('fontSize')];
 * const map = kvFieldsToMap(kv);
 * // { theme: { field: { id: 'theme', ... } }, fontSize: { field: { id: 'fontSize', ... } } }
 * ```
 */
export function kvFieldsToMap<TKv extends readonly KvField[]>(
	kvFields: TKv,
): { [K in TKv[number]['id']]: { field: KvFieldById<TKv, K> } } {
	return Object.fromEntries(kvFields.map((f) => [f.id, { field: f }])) as {
		[K in TKv[number]['id']]: { field: KvFieldById<TKv, K> };
	};
}

/**
 * Get a table by id from an array of TableDefinitions.
 *
 * @example
 * ```typescript
 * const postsTable = getTableById(workspace.tables, 'posts');
 * ```
 */
export function getTableById<TTables extends readonly TableDefinition[]>(
	tables: TTables,
	id: string,
): TableDefinition | undefined {
	return tables.find((t) => t.id === id);
}

/**
 * Get a KV field by id from an array of KvFields.
 *
 * @example
 * ```typescript
 * const themeField = getKvFieldById(workspace.kv, 'theme');
 * ```
 */
export function getKvFieldById<TKv extends readonly KvField[]>(
	kv: TKv,
	id: string,
): KvField | undefined {
	return kv.find((f) => f.id === id);
}
