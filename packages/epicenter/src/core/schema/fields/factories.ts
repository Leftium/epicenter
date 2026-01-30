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
	BooleanField,
	DateField,
	Field,
	FieldOptions,
	Icon,
	IdField,
	IntegerField,
	JsonField,
	RealField,
	RichtextField,
	SelectField,
	TableDefinition,
	TagsField,
	TextField,
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
 * Takes the table id as the first argument, then options:
 * - `id`: Required unique identifier for the table (first argument).
 * - `name`: Required display name for the table.
 * - `fields`: Required field array (Field[]).
 * - `description`: Optional. Defaults to empty string.
 * - `icon`: Optional. Accepts Icon string ('emoji:📝'), plain emoji ('📝'), or null. Defaults to null.
 *
 * @example
 * ```typescript
 * // Minimal - id, name, and fields required
 * const posts = table('posts', {
 *   name: 'Posts',
 *   fields: [id(), text('title'), boolean('published')],
 * });
 *
 * // With icon (tagged format)
 * const posts = table('posts', {
 *   name: 'Posts',
 *   icon: 'emoji:📝',
 *   fields: [id(), text('title')],
 * });
 *
 * // With icon shorthand (plain emoji)
 * const posts = table('posts', {
 *   name: 'Posts',
 *   icon: '📝',  // Converted to 'emoji:📝'
 *   fields: [id(), text('title')],
 * });
 *
 * // Full - all metadata explicit
 * const posts = table('posts', {
 *   name: 'Blog Posts',
 *   description: 'Articles and blog posts',
 *   icon: 'emoji:📝',
 *   fields: [id(), text('title'), boolean('published')],
 * });
 *
 * // In defineWorkspace with arrays
 * defineWorkspace({
 *   tables: [
 *     table('posts', { name: 'Posts', fields: [id(), text('title')] }),
 *     table('comments', { name: 'Comments', fields: [id(), text('body')] }),
 *   ],
 *   kv: [],
 * });
 * ```
 */
export function table<const TFields extends readonly Field[]>(
	tableId: string,
	options: {
		name: string;
		fields: TFields;
		description?: string;
		icon?: string | Icon | null;
	},
): TableDefinition<TFields> {
	return {
		id: tableId,
		name: options.name,
		description: options.description ?? '',
		icon: normalizeIcon(options.icon),
		fields: options.fields,
	};
}

/**
 * Create an ID field.
 *
 * Defaults to field id 'id'. Can override with a custom id.
 *
 * @example
 * ```typescript
 * id()           // { id: 'id', type: 'id', ... }
 * id('userId')   // { id: 'userId', type: 'id', ... }
 * ```
 */
export function id(): IdField & { id: 'id' };
export function id<const K extends string>(
	fieldId: K,
	opts?: FieldOptions,
): IdField & { id: K };
export function id<const K extends string>(
	fieldId: K = 'id' as K,
	{ name = '', description = '', icon = null }: FieldOptions = {},
): IdField & { id: K } {
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
): TextField<false> & { id: K };
export function text<const K extends string>(
	id: K,
	opts: FieldOptions & { nullable: true; default?: string },
): TextField<true> & { id: K };
export function text<const K extends string>(
	id: K,
	{
		nullable = false,
		default: defaultValue,
		name = '',
		description = '',
		icon = null,
	}: FieldOptions & { nullable?: boolean; default?: string } = {},
): TextField<boolean> & { id: K } {
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
): RichtextField & { id: K } {
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
): IntegerField<false> & { id: K };
export function integer<const K extends string>(
	id: K,
	opts: FieldOptions & { nullable: true; default?: number },
): IntegerField<true> & { id: K };
export function integer<const K extends string>(
	id: K,
	{
		nullable = false,
		default: defaultValue,
		name = '',
		description = '',
		icon = null,
	}: FieldOptions & { nullable?: boolean; default?: number } = {},
): IntegerField<boolean> & { id: K } {
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
): RealField<false> & { id: K };
export function real<const K extends string>(
	id: K,
	opts: FieldOptions & { nullable: true; default?: number },
): RealField<true> & { id: K };
export function real<const K extends string>(
	id: K,
	{
		nullable = false,
		default: defaultValue,
		name = '',
		description = '',
		icon = null,
	}: FieldOptions & { nullable?: boolean; default?: number } = {},
): RealField<boolean> & { id: K } {
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
): BooleanField<false> & { id: K };
export function boolean<const K extends string>(
	id: K,
	opts: FieldOptions & { nullable: true; default?: boolean },
): BooleanField<true> & { id: K };
export function boolean<const K extends string>(
	id: K,
	{
		nullable = false,
		default: defaultValue,
		name = '',
		description = '',
		icon = null,
	}: FieldOptions & { nullable?: boolean; default?: boolean } = {},
): BooleanField<boolean> & { id: K } {
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
): DateField<false> & { id: K };
export function date<const K extends string>(
	id: K,
	opts: FieldOptions & { nullable: true; default?: Temporal.ZonedDateTime },
): DateField<true> & { id: K };
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
): DateField<boolean> & { id: K } {
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
 * select('status', { options: ['draft', 'published'] })
 * select('priority', { options: ['low', 'medium', 'high'], default: 'medium' })
 * select('category', { options: ['a', 'b', 'c'], nullable: true })
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
): SelectField<TOptions, true> & { id: K };
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
): SelectField<TOptions, false> & { id: K };
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
): SelectField<TOptions, boolean> & { id: K } {
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
 * tags('labels')                                              // unconstrained
 * tags('categories', { options: ['tech', 'news', 'sports'] }) // constrained
 * tags('tags', { nullable: true })                            // nullable
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
): TagsField<TOptions, true> & { id: K };
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
): TagsField<TOptions, false> & { id: K };
export function tags<const K extends string, TNullable extends boolean = false>(
	id: K,
	opts?: FieldOptions & {
		nullable?: TNullable;
		default?: string[];
	},
): TagsField<readonly [string, ...string[]], TNullable> & { id: K };
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
): TagsField<TOptions, boolean> & { id: K } {
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
): JsonField<T, true> & { id: K };
export function json<const K extends string, const T extends TSchema>(
	id: K,
	opts: FieldOptions & {
		schema: T;
		nullable?: false;
		default?: Static<T>;
	},
): JsonField<T, false> & { id: K };
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
): JsonField<T, boolean> & { id: K } {
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
