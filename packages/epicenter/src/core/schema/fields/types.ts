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
 * ```
 * TableDefinition
 * ├── name, icon, description    ← TableMetadata (table-level)
 * └── fields
 *     ├── { id: "id", ... }
 *     │   ├── name, icon, description  ← FieldMetadata (column-level)
 *     │   └── type: "id"
 *     └── { id: "title", ... }
 *         ├── name, icon, description  ← FieldMetadata (column-level)
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
// Field Schema Types
// ============================================================================

/**
 * ID field schema - auto-generated primary key.
 * Always NOT NULL (implicit, no nullable field needed).
 */
export type IdFieldSchema = FieldMetadata & {
	type: 'id';
};

/**
 * Text field schema - single-line string input.
 */
export type TextFieldSchema<TNullable extends boolean = boolean> =
	FieldMetadata & {
		type: 'text';
		nullable?: TNullable;
		default?: string;
	};

/**
 * Rich text reference field schema - stores ID pointing to separate rich content document.
 * The ID references a separate Y.Doc for collaborative editing.
 * The row itself just stores the string ID (JSON-serializable).
 *
 * Always nullable - Y.Docs are created lazily when user first edits.
 * No need to specify nullable or default; they're implicit.
 */
export type RichtextFieldSchema = FieldMetadata & {
	type: 'richtext';
};

/**
 * Integer field schema - whole numbers.
 */
export type IntegerFieldSchema<TNullable extends boolean = boolean> =
	FieldMetadata & {
		type: 'integer';
		nullable?: TNullable;
		default?: number;
	};

/**
 * Real/float field schema - decimal numbers.
 */
export type RealFieldSchema<TNullable extends boolean = boolean> =
	FieldMetadata & {
		type: 'real';
		nullable?: TNullable;
		default?: number;
	};

/**
 * Boolean field schema - true/false values.
 */
export type BooleanFieldSchema<TNullable extends boolean = boolean> =
	FieldMetadata & {
		type: 'boolean';
		nullable?: TNullable;
		default?: boolean;
	};

/**
 * Date field schema - timezone-aware dates.
 * Stored as DateTimeString format: `{iso}|{timezone}`.
 */
export type DateFieldSchema<TNullable extends boolean = boolean> =
	FieldMetadata & {
		type: 'date';
		nullable?: TNullable;
		default?: DateTimeString;
	};

/**
 * Select field schema - single choice from predefined options.
 *
 * @example
 * ```typescript
 * {
 *   type: 'select',
 *   options: ['draft', 'published', 'archived'],
 *   default: 'draft'
 * }
 * ```
 */
export type SelectFieldSchema<
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
 * Tags field schema - array of strings with optional validation.
 * Stored as plain arrays (JSON-serializable).
 *
 * Two modes:
 * - With `options`: Only values from options are allowed
 * - Without `options`: Any string array is allowed
 *
 * @example
 * ```typescript
 * // Validated tags
 * { type: 'tags', options: ['urgent', 'normal', 'low'] }
 *
 * // Unconstrained tags
 * { type: 'tags' }
 * ```
 */
export type TagsFieldSchema<
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
 * JSON field schema - arbitrary JSON validated by a TypeBox schema.
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
 *   type: 'json',
 *   schema: Type.Object({ theme: Type.String(), darkMode: Type.Boolean() }),
 *   default: { theme: 'dark', darkMode: true }
 * }
 * ```
 */
export type JsonFieldSchema<
	T extends TSchema = TSchema,
	TNullable extends boolean = boolean,
> = FieldMetadata & {
	type: 'json';
	schema: T;
	nullable?: TNullable;
	default?: Static<T>;
};

// ============================================================================
// Discriminated Unions and Utility Types
// ============================================================================

/**
 * Discriminated union of all field schema types (without id property).
 * Use `type` to narrow to a specific type.
 */
export type FieldSchema =
	| IdFieldSchema
	| TextFieldSchema
	| RichtextFieldSchema
	| IntegerFieldSchema
	| RealFieldSchema
	| BooleanFieldSchema
	| DateFieldSchema
	| SelectFieldSchema
	| TagsFieldSchema
	| JsonFieldSchema;

/**
 * THE Field type - schema with id property included.
 * This is the normalized form used in TableDefinition.fields array.
 */
export type Field = FieldSchema & {
	/** Field identifier */
	id: string;
};

/**
 * Extract the type name from a field definition.
 * One of: 'id', 'text', 'richtext', 'integer', 'real', 'boolean', 'date', 'select', 'tags', 'json'
 */
export type FieldType = FieldSchema['type'];

// ============================================================================
// Type Utilities for Field Arrays
// ============================================================================

/**
 * Get specific field by id from array.
 */
export type FieldById<TFields extends readonly Field[], K extends string> =
	Extract<TFields[number], { id: K }>;

/**
 * Get union of all field ids from array.
 */
export type FieldIds<TFields extends readonly Field[]> = TFields[number]['id'];

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
 * This also correctly handles RichtextFieldSchema (no nullable property)
 * because optional properties can be absent.
 */
type IsNullable<C extends FieldSchema> = C extends { nullable?: true }
	? true
	: false;

/**
 * Maps a field definition to its runtime value type.
 *
 * - RichtextFieldSchema → string | null (always nullable)
 * - TagsFieldSchema → string[] (plain array)
 * - DateFieldSchema → DateTimeString
 * - Other fields → primitive types
 *
 * Nullability is derived from the definition's `nullable` field.
 */
export type CellValue<C extends FieldSchema = FieldSchema> =
	C extends IdFieldSchema
		? string
		: C extends TextFieldSchema
			? IsNullable<C> extends true
				? string | null
				: string
			: C extends RichtextFieldSchema
				? string | null // always nullable
				: C extends IntegerFieldSchema
					? IsNullable<C> extends true
						? number | null
						: number
					: C extends RealFieldSchema
						? IsNullable<C> extends true
							? number | null
							: number
						: C extends BooleanFieldSchema
							? IsNullable<C> extends true
								? boolean | null
								: boolean
							: C extends DateFieldSchema
								? IsNullable<C> extends true
									? DateTimeString | null
									: DateTimeString
								: C extends SelectFieldSchema<infer TOptions>
									? IsNullable<C> extends true
										? TOptions[number] | null
										: TOptions[number]
									: C extends TagsFieldSchema<infer TOptions>
										? IsNullable<C> extends true
											? TOptions[number][] | null
											: TOptions[number][]
										: C extends JsonFieldSchema<infer T extends TSchema>
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
 * const postsTable: TableDefinition = {
 *   name: 'Posts',
 *   description: 'Blog posts and articles',
 *   icon: 'emoji:📝',
 *   fields: [
 *     { id: 'id', type: 'id', name: '', description: '', icon: null },
 *     { id: 'title', type: 'text', name: '', description: '', icon: null },
 *     { id: 'status', type: 'select', name: '', description: '', icon: null, options: ['draft', 'published'] },
 *   ],
 * };
 * ```
 */
export type TableDefinition<TFields extends readonly Field[] = Field[]> = {
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
 * This is the normalized format that flows through the entire system
 * (capabilities, table helpers, etc.). Created using the `table()` factory
 * function for each table.
 *
 * @example
 * ```typescript
 * const blogTables: TableDefinitionMap = {
 *   posts: {
 *     name: 'Posts',
 *     description: 'Blog posts',
 *     icon: 'emoji:📝',
 *     fields: [id(), text('title')],
 *   },
 * };
 * ```
 */
export type TableDefinitionMap = Record<string, TableDefinition<readonly Field[]>>;

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
export type Row<TFields extends readonly Field[] = Field[]> = {
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
export type PartialRow<TFields extends readonly Field[] = Field[]> = {
	id: string;
} & Partial<Omit<Row<TFields>, 'id'>>;

// ============================================================================
// Key-Value Schema Types
// ============================================================================

/**
 * Field definition for KV stores (excludes IdFieldSchema).
 * KV entries don't have IDs; they're keyed by string.
 */
export type KvField = Exclude<FieldSchema, IdFieldSchema>;

/**
 * Runtime value type for a KV entry.
 */
export type KvValue<C extends KvField = KvField> = CellValue<C>;

/**
 * KV entry definition with metadata for UI display.
 *
 * Parallel to TableDefinition, but wraps a single field instead of a fields map.
 * Conceptually, a KV store is like a single row where each key is a column.
 *
 * @example
 * ```typescript
 * const themeKv: KvDefinition = {
 *   name: 'Theme',
 *   icon: 'emoji:🎨',
 *   description: 'Application color theme',
 *   field: select('theme', { options: ['light', 'dark'] }),
 * };
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
 * This is the normalized format that flows through the entire system.
 * Created using the `kv()` factory function for each key-value entry.
 *
 * @example
 * ```typescript
 * const settingsKv: KvDefinitionMap = {
 *   theme: {
 *     name: 'Theme',
 *     icon: 'emoji:🎨',
 *     description: 'Application color theme',
 *     field: select('theme', { options: ['light', 'dark'], default: 'light' }),
 *   },
 *   fontSize: {
 *     name: 'Font Size',
 *     icon: 'emoji:🔤',
 *     description: 'Editor font size in pixels',
 *     field: integer('fontSize', { default: 14 }),
 *   },
 * };
 * ```
 */
export type KvDefinitionMap = Record<string, KvDefinition>;

/**
 * Map of KV keys to their field schemas (no metadata).
 *
 * This is a minimal input format for KV definitions where metadata
 * (name, icon, etc.) is auto-generated.
 *
 * @example
 * ```typescript
 * const kv: KvMap = {
 *   theme: select('theme', { options: ['light', 'dark'] as const, default: 'light' }),
 *   fontSize: integer('fontSize', { default: 14 }),
 * };
 *
 * // Use in defineWorkspace:
 * const definition = defineWorkspace({
 *   tables: { posts: table({ name: 'Posts', fields: [id(), text('title')] as const }) },
 *   kv,  // KvMap
 * });
 * ```
 */
export type KvMap = Record<string, KvField>;
