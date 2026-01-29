/**
 * Field factory functions for creating minimal field schemas.
 *
 * Each function returns a minimal schema object with `type` as the discriminant.
 * No redundant JSON Schema fields; derive JSON Schema on-demand for export.
 *
 * All factories follow the ID-first pattern: the field id is the first argument,
 * and options (including metadata) come second.
 */

import type { Temporal } from 'temporal-polyfill';
import type { Static, TSchema } from 'typebox';
import { DateTimeString } from './datetime';
import type {
	BooleanFieldSchema,
	DateFieldSchema,
	Field,
	FieldOptions,
	Icon,
	IdFieldSchema,
	IntegerFieldSchema,
	JsonFieldSchema,
	KvDefinition,
	KvField,
	RealFieldSchema,
	RichtextFieldSchema,
	SelectFieldSchema,
	TableDefinition,
	TagsFieldSchema,
	TextFieldSchema,
} from './types';
import { isIcon } from './types';

/**
 * Normalize icon input to Icon | null.
 *
 * Accepts:
 * - Icon string (tagged format) → unchanged
 * - Plain emoji string → converted to 'emoji:{value}'
 * - null/undefined → null
 */
function normalizeIcon(icon: string | Icon | null | undefined): Icon | null {
	if (icon === undefined || icon === null) return null;
	if (isIcon(icon)) return icon;
	// Plain string (emoji) → convert to tagged format
	return `emoji:${icon}` as Icon;
}

/**
 * Factory function to create a TableDefinition.
 *
 * `name` and `fields` are required. `description` and `icon` are optional:
 * - `name`: Required display name for the table.
 * - `fields`: Required field array (Field[]).
 * - `description`: Optional. Defaults to empty string.
 * - `icon`: Optional. Accepts Icon string ('emoji:📝'), plain emoji ('📝'), or null. Defaults to null.
 *
 * @example
 * ```typescript
 * // Minimal - name and fields required
 * const posts = table({
 *   name: 'Posts',
 *   fields: [id(), text('title'), boolean('published')] as const,
 * });
 *
 * // With icon (tagged format)
 * const posts = table({
 *   name: 'Posts',
 *   icon: 'emoji:📝',
 *   fields: [id(), text('title')] as const,
 * });
 *
 * // With icon shorthand (plain emoji)
 * const posts = table({
 *   name: 'Posts',
 *   icon: '📝',  // Converted to 'emoji:📝'
 *   fields: [id(), text('title')] as const,
 * });
 *
 * // Full - all metadata explicit
 * const posts = table({
 *   name: 'Blog Posts',
 *   description: 'Articles and blog posts',
 *   icon: 'emoji:📝',
 *   fields: [id(), text('title'), boolean('published')] as const,
 * });
 *
 * // In defineWorkspace
 * defineWorkspace({
 *   tables: {
 *     posts: table({ name: 'Posts', fields: [id(), text('title')] as const }),
 *   },
 *   kv: {},
 * });
 * ```
 */
export function table<const TFields extends readonly Field[]>(options: {
	name: string;
	fields: TFields;
	description?: string;
	icon?: string | Icon | null;
}): TableDefinition<TFields> {
	return {
		name: options.name,
		description: options.description ?? '',
		icon: normalizeIcon(options.icon),
		fields: options.fields,
	};
}

/**
 * Factory function to create a KvDefinition (setting) with sensible defaults.
 *
 * Requires `name` and `field`; other metadata is optional.
 * For tests where you don't care about the name, use `name: ''`.
 *
 * Conceptually, a KV store is like a single table row where each key is a column.
 * While TableDefinition wraps a map of fields, KvDefinition wraps a single field.
 *
 * @example
 * ```typescript
 * import { setting, select, integer } from '@epicenter/hq';
 *
 * // Production use - with meaningful metadata
 * const theme = setting({
 *   name: 'Theme',
 *   icon: 'emoji:🎨',
 *   field: select('theme', { options: ['light', 'dark'], default: 'light' }),
 *   description: 'Application color theme',
 * });
 *
 * // Test use - minimal
 * const count = setting({
 *   name: '',
 *   field: integer('count', { default: 0 }),
 * });
 * ```
 */
export function setting<TField extends KvField>(options: {
	name: string;
	field: TField;
	icon?: string | Icon | null;
	description?: string;
}): KvDefinition<TField> {
	return {
		name: options.name,
		icon: normalizeIcon(options.icon),
		description: options.description ?? '',
		field: options.field,
	};
}

/**
 * Create an ID field schema.
 *
 * Defaults to field id 'id'. Can override with a custom id.
 *
 * @example
 * ```typescript
 * id()           // { id: 'id', type: 'id', ... }
 * id('userId')   // { id: 'userId', type: 'id', ... }
 * ```
 */
export function id(): IdFieldSchema & { id: 'id' };
export function id<const K extends string>(
	fieldId: K,
	opts?: FieldOptions,
): IdFieldSchema & { id: K };
export function id<const K extends string>(
	fieldId: K = 'id' as K,
	{ name = '', description = '', icon = null }: FieldOptions = {},
): IdFieldSchema & { id: K } {
	return {
		id: fieldId,
		type: 'id',
		name,
		description,
		icon,
	};
}

/**
 * Create a text field schema.
 *
 * @example
 * ```typescript
 * text('title')                          // non-nullable
 * text('subtitle', { nullable: true })   // nullable
 * text('name', { default: 'Untitled' })  // with default
 * ```
 */
export function text<const K extends string>(
	id: K,
	opts?: FieldOptions & { nullable?: false; default?: string },
): TextFieldSchema<false> & { id: K };
export function text<const K extends string>(
	id: K,
	opts: FieldOptions & { nullable: true; default?: string },
): TextFieldSchema<true> & { id: K };
export function text<const K extends string>(
	id: K,
	{
		nullable = false,
		default: defaultValue,
		name = '',
		description = '',
		icon = null,
	}: FieldOptions & { nullable?: boolean; default?: string } = {},
): TextFieldSchema<boolean> & { id: K } {
	return {
		id,
		type: 'text',
		name,
		description,
		icon,
		...(nullable && { nullable: true }),
		...(defaultValue !== undefined && { default: defaultValue }),
	};
}

/**
 * Create a richtext field schema.
 *
 * @example
 * ```typescript
 * richtext('content')
 * richtext('body', { name: 'Post Body', icon: 'emoji:📝' })
 * ```
 */
export function richtext<const K extends string>(
	id: K,
	{ name = '', description = '', icon = null }: FieldOptions = {},
): RichtextFieldSchema & { id: K } {
	return {
		id,
		type: 'richtext',
		name,
		description,
		icon,
	};
}

/**
 * Create an integer field schema.
 *
 * @example
 * ```typescript
 * integer('views')                        // non-nullable
 * integer('rating', { nullable: true })   // nullable
 * integer('count', { default: 0 })        // with default
 * ```
 */
export function integer<const K extends string>(
	id: K,
	opts?: FieldOptions & { nullable?: false; default?: number },
): IntegerFieldSchema<false> & { id: K };
export function integer<const K extends string>(
	id: K,
	opts: FieldOptions & { nullable: true; default?: number },
): IntegerFieldSchema<true> & { id: K };
export function integer<const K extends string>(
	id: K,
	{
		nullable = false,
		default: defaultValue,
		name = '',
		description = '',
		icon = null,
	}: FieldOptions & { nullable?: boolean; default?: number } = {},
): IntegerFieldSchema<boolean> & { id: K } {
	return {
		id,
		type: 'integer',
		name,
		description,
		icon,
		...(nullable && { nullable: true }),
		...(defaultValue !== undefined && { default: defaultValue }),
	};
}

/**
 * Create a real (float) field schema.
 *
 * @example
 * ```typescript
 * real('price')                          // non-nullable
 * real('discount', { nullable: true })   // nullable
 * real('rate', { default: 0.0 })         // with default
 * ```
 */
export function real<const K extends string>(
	id: K,
	opts?: FieldOptions & { nullable?: false; default?: number },
): RealFieldSchema<false> & { id: K };
export function real<const K extends string>(
	id: K,
	opts: FieldOptions & { nullable: true; default?: number },
): RealFieldSchema<true> & { id: K };
export function real<const K extends string>(
	id: K,
	{
		nullable = false,
		default: defaultValue,
		name = '',
		description = '',
		icon = null,
	}: FieldOptions & { nullable?: boolean; default?: number } = {},
): RealFieldSchema<boolean> & { id: K } {
	return {
		id,
		type: 'real',
		name,
		description,
		icon,
		...(nullable && { nullable: true }),
		...(defaultValue !== undefined && { default: defaultValue }),
	};
}

/**
 * Create a boolean field schema.
 *
 * @example
 * ```typescript
 * boolean('published')                       // non-nullable
 * boolean('verified', { nullable: true })    // nullable
 * boolean('active', { default: false })      // with default
 * ```
 */
export function boolean<const K extends string>(
	id: K,
	opts?: FieldOptions & { nullable?: false; default?: boolean },
): BooleanFieldSchema<false> & { id: K };
export function boolean<const K extends string>(
	id: K,
	opts: FieldOptions & { nullable: true; default?: boolean },
): BooleanFieldSchema<true> & { id: K };
export function boolean<const K extends string>(
	id: K,
	{
		nullable = false,
		default: defaultValue,
		name = '',
		description = '',
		icon = null,
	}: FieldOptions & { nullable?: boolean; default?: boolean } = {},
): BooleanFieldSchema<boolean> & { id: K } {
	return {
		id,
		type: 'boolean',
		name,
		description,
		icon,
		...(nullable && { nullable: true }),
		...(defaultValue !== undefined && { default: defaultValue }),
	};
}

/**
 * Create a date field schema.
 *
 * @example
 * ```typescript
 * date('createdAt')                        // non-nullable
 * date('deletedAt', { nullable: true })    // nullable
 * date('startDate', { default: now })      // with default (Temporal.ZonedDateTime)
 * ```
 */
export function date<const K extends string>(
	id: K,
	opts?: FieldOptions & { nullable?: false; default?: Temporal.ZonedDateTime },
): DateFieldSchema<false> & { id: K };
export function date<const K extends string>(
	id: K,
	opts: FieldOptions & { nullable: true; default?: Temporal.ZonedDateTime },
): DateFieldSchema<true> & { id: K };
export function date<const K extends string>(
	id: K,
	{
		nullable = false,
		default: defaultValue,
		name = '',
		description = '',
		icon = null,
	}: FieldOptions & {
		nullable?: boolean;
		default?: Temporal.ZonedDateTime;
	} = {},
): DateFieldSchema<boolean> & { id: K } {
	return {
		id,
		type: 'date',
		name,
		description,
		icon,
		...(nullable && { nullable: true }),
		...(defaultValue !== undefined && {
			default: DateTimeString.stringify(defaultValue),
		}),
	};
}

/**
 * Create a select field schema.
 *
 * @example
 * ```typescript
 * select('status', { options: ['draft', 'published'] as const })
 * select('priority', { options: ['low', 'medium', 'high'] as const, default: 'medium' })
 * select('category', { options: ['a', 'b', 'c'] as const, nullable: true })
 * ```
 */
export function select<
	const K extends string,
	const TOptions extends readonly [string, ...string[]],
>(
	id: K,
	opts: FieldOptions & {
		options: TOptions;
		nullable: true;
		default?: TOptions[number];
	},
): SelectFieldSchema<TOptions, true> & { id: K };
export function select<
	const K extends string,
	const TOptions extends readonly [string, ...string[]],
>(
	id: K,
	opts: FieldOptions & {
		options: TOptions;
		nullable?: false;
		default?: TOptions[number];
	},
): SelectFieldSchema<TOptions, false> & { id: K };
export function select<
	const K extends string,
	const TOptions extends readonly [string, ...string[]],
>(
	id: K,
	{
		options,
		nullable = false,
		default: defaultValue,
		name = '',
		description = '',
		icon = null,
	}: FieldOptions & {
		options: TOptions;
		nullable?: boolean;
		default?: TOptions[number];
	},
): SelectFieldSchema<TOptions, boolean> & { id: K } {
	return {
		id,
		type: 'select',
		name,
		description,
		icon,
		options,
		...(nullable && { nullable: true }),
		...(defaultValue !== undefined && { default: defaultValue }),
	};
}

/**
 * Create a tags field schema.
 *
 * Two modes:
 * - With `options`: Only values from options are allowed
 * - Without `options`: Any string array is allowed
 *
 * @example
 * ```typescript
 * tags('labels')                                                      // unconstrained
 * tags('categories', { options: ['tech', 'news', 'sports'] as const }) // constrained
 * tags('tags', { nullable: true })                                    // nullable
 * ```
 */
export function tags<
	const K extends string,
	const TOptions extends readonly [string, ...string[]],
>(
	id: K,
	opts: FieldOptions & {
		options: TOptions;
		nullable: true;
		default?: TOptions[number][];
	},
): TagsFieldSchema<TOptions, true> & { id: K };
export function tags<
	const K extends string,
	const TOptions extends readonly [string, ...string[]],
>(
	id: K,
	opts: FieldOptions & {
		options: TOptions;
		nullable?: false;
		default?: TOptions[number][];
	},
): TagsFieldSchema<TOptions, false> & { id: K };
export function tags<const K extends string, TNullable extends boolean = false>(
	id: K,
	opts?: FieldOptions & {
		nullable?: TNullable;
		default?: string[];
	},
): TagsFieldSchema<readonly [string, ...string[]], TNullable> & { id: K };
export function tags<
	const K extends string,
	const TOptions extends readonly [string, ...string[]],
>(
	id: K,
	{
		options,
		nullable = false,
		default: defaultValue,
		name = '',
		description = '',
		icon = null,
	}: FieldOptions & {
		options?: TOptions;
		nullable?: boolean;
		default?: TOptions[number][] | string[];
	} = {},
): TagsFieldSchema<TOptions, boolean> & { id: K } {
	return {
		id,
		type: 'tags',
		name,
		description,
		icon,
		...(options && { options }),
		...(nullable && { nullable: true }),
		...(defaultValue !== undefined && {
			default: defaultValue as TOptions[number][],
		}),
	};
}

/**
 * Create a JSON field schema with TypeBox validation.
 *
 * @example
 * ```typescript
 * import { Type } from 'typebox';
 *
 * json('settings', { schema: Type.Object({ theme: Type.String() }) })
 * json('config', {
 *   schema: Type.Object({ darkMode: Type.Boolean() }),
 *   default: { darkMode: false }
 * })
 * ```
 */
export function json<const K extends string, const T extends TSchema>(
	id: K,
	opts: FieldOptions & {
		schema: T;
		nullable: true;
		default?: Static<T>;
	},
): JsonFieldSchema<T, true> & { id: K };
export function json<const K extends string, const T extends TSchema>(
	id: K,
	opts: FieldOptions & {
		schema: T;
		nullable?: false;
		default?: Static<T>;
	},
): JsonFieldSchema<T, false> & { id: K };
export function json<const K extends string, const T extends TSchema>(
	id: K,
	{
		schema,
		nullable = false,
		default: defaultValue,
		name = '',
		description = '',
		icon = null,
	}: FieldOptions & {
		schema: T;
		nullable?: boolean;
		default?: Static<T>;
	},
): JsonFieldSchema<T, boolean> & { id: K } {
	return {
		id,
		type: 'json',
		name,
		description,
		icon,
		schema,
		...(nullable && { nullable: true }),
		...(defaultValue !== undefined && { default: defaultValue }),
	};
}
