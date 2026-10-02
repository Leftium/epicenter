/**
 * What a `field.*` helper adds to the native TypeBox schema it returns.
 *
 * A field is one native schema. TypeBox checks values against it, and the
 * {@link FIELD_KEYWORD} annotation on the same object says which editor it
 * gets. Both come from the same helper call, so neither is derived from the
 * other and nothing reads the schema's keywords to guess a kind.
 */

import type { TSchema } from 'typebox';
import { Memory } from 'typebox/system';

/** The annotation keyword. TypeBox ignores it; storages and widgets read it. */
export const FIELD_KEYWORD = 'x-field';

/**
 * The hidden keyword a helper leaves beside the annotation.
 *
 * It is not enumerable, like TypeBox's own `~kind` and `~refine`, so it
 * follows the same rule they do: TypeBox's clone and `Type.Refine` carry it,
 * and a spread or a rebuild from enumerable keywords loses it together with
 * every refinement. `compileData` requires it, which is how a field that lost
 * its hidden constraints on the way is refused rather than compiled without
 * them.
 *
 * It records that a helper built the schema. It is not an integrity check: an
 * author who edits a helper's schema natively owns that edit.
 */
export const FIELD_MARK = '~field';

/**
 * The editor a field gets, and what that editor needs beyond the schema.
 *
 * `number` and `integer` stay distinct kinds even where one widget serves
 * both. `nullable` is a flag, not a kind: a nullable select is still a select.
 */
export type FieldMetadata = { readonly nullable: boolean } & (
	| {
			readonly kind:
				| 'string'
				| 'url'
				| 'number'
				| 'integer'
				| 'boolean'
				| 'date'
				| 'instant'
				| 'datetime'
				| 'tags'
				| 'json';
	  }
	| {
			readonly kind: 'select' | 'multiSelect';
			readonly options: readonly string[];
	  }
	| { readonly kind: 'reference'; readonly target: string }
);

/** The field kinds. */
export type Kind = FieldMetadata['kind'];

const KINDS: ReadonlySet<string> = new Set<Kind>([
	'string',
	'url',
	'number',
	'integer',
	'boolean',
	'date',
	'instant',
	'datetime',
	'tags',
	'json',
	'select',
	'multiSelect',
	'reference',
]);

/**
 * A native schema `S` that a `field.*` helper built, annotated with `M`.
 *
 * `Static<FieldSchema<S>>` is `Static<S>`. `M` is the annotation exactly as
 * the helper wrote it, so `field.select(['a', 'b'])['x-field'].options` is
 * `readonly ['a', 'b']`. A bare `Type.String()` carries neither keyword, which
 * is why a declaration does not take one.
 */
export type FieldSchema<
	S extends TSchema = TSchema,
	M extends FieldMetadata = FieldMetadata,
> = S & {
	readonly [FIELD_KEYWORD]: M;
	readonly [FIELD_MARK]: true;
};

/**
 * Finish a helper's schema: a native copy of `schema` carrying the annotation
 * and the mark.
 *
 * This is the one bridge between the runtime schema and the type a helper
 * declares. `S` differs from what `schema` is only where no native constructor
 * can say it: a branded `Static` over a plain string.
 *
 * `Memory.Update` is how TypeBox itself adds a keyword (`Type.Refine` is one
 * call to it). It clones `schema` with its hidden keywords, so whatever the
 * helper was given is left as it was, frozen or not, and an annotation already
 * there is replaced on the copy. The result is an ordinary mutable schema;
 * only the small annotation object is frozen.
 */
export function attach<S extends TSchema, const M extends FieldMetadata>(
	schema: TSchema,
	metadata: M,
): FieldSchema<S, M> {
	return Memory.Update(
		schema,
		{ [FIELD_MARK]: true },
		{ [FIELD_KEYWORD]: Object.freeze(metadata) },
	) as FieldSchema<S, M>;
}

/** Whether a schema still carries the mark a helper left. */
export function isHelperBuilt(schema: object): boolean {
	return Object.getOwnPropertyDescriptor(schema, FIELD_MARK)?.value === true;
}

/** The annotation on a declared field, or `null` when a value has none. */
export function fieldMetadataOf(schema: unknown): FieldMetadata | null {
	if (typeof schema !== 'object' || schema === null || Array.isArray(schema))
		return null;
	const metadata: unknown = Object.getOwnPropertyDescriptor(
		schema,
		FIELD_KEYWORD,
	)?.value;
	if (typeof metadata !== 'object' || metadata === null) return null;
	const { kind, nullable, options, target } = metadata as Record<
		string,
		unknown
	>;
	if (typeof kind !== 'string' || !KINDS.has(kind)) return null;
	if (typeof nullable !== 'boolean') return null;
	if (
		(kind === 'select' || kind === 'multiSelect') &&
		!(Array.isArray(options) && options.every((o) => typeof o === 'string'))
	)
		return null;
	if (kind === 'reference' && typeof target !== 'string') return null;
	return metadata as FieldMetadata;
}
