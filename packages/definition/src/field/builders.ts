/**
 * The `field.*` helpers: the one way to declare a field.
 *
 * Each helper returns a native TypeBox schema, so `Static`, `Compile`, and
 * `Value.Check` read it directly, and annotates it with the editor it gets
 * (see `./metadata`). The schema and the annotation are built from the same
 * arguments in the same call:
 *
 *   field.select(['a', 'b'])   Type.Enum(['a', 'b'])   { kind: 'select', options: ['a', 'b'] }
 *   field.reference('pages')   Type.String({ minLength: 1 })   { kind: 'reference', target: 'pages' }
 *   field.nullable(inner)      Type.Union([inner, Type.Null()])   inner's annotation, nullable
 *   field.json(schema)         schema itself, behind a JSON-value gate   { kind: 'json' }
 *
 * A helper takes only the options listed in its type and refuses any other
 * key, so an option cannot replace the `type`, `format`, or annotation the
 * helper sets. It copies what it is given: changing an options object, an
 * option list, or a payload schema after the call changes nothing here.
 *
 * What a helper returns is an ordinary native schema, as mutable as any
 * `Type.*` result. `compileData` is what takes ownership: it compiles a frozen
 * snapshot. Editing a helper's schema natively before then is the author's
 * edit to make and to answer for.
 *
 * Closed sets hold strings. A numeric range is an `integer` with `minimum`
 * and `maximum`, not a select.
 */

import {
	type Static,
	type TArray,
	type TBoolean,
	type TEnum,
	type TInteger,
	type TNull,
	type TNumber,
	type TSchema,
	type TString,
	type TUnion,
	type TUnsafe,
	Type,
} from 'typebox';
import type { Brand } from 'wellcrafted/brand';
import type { JsonValue } from 'wellcrafted/json';
import { isJsonSafe } from '../json.js';
import type { CalendarDateString } from './calendar-date-string.js';
import type { DateTimeString } from './datetime-string.js';
import {
	INSTANT_STRING_PATTERN,
	type InstantString,
} from './instant-string.js';
import {
	attach,
	type FIELD_KEYWORD,
	type FieldMetadata,
	type FieldSchema,
	fieldMetadataOf,
	isHelperBuilt,
	type Kind,
} from './metadata.js';

/** A helper's annotation: its kind, not nullable, and what the kind adds. */
type Meta<K extends Kind, TExtra = unknown> = {
	readonly kind: K;
	readonly nullable: false;
} & TExtra;

/** An annotation with `nullable` set and everything else as it was. */
type Nullable<M> = M extends unknown
	? Omit<M, 'nullable'> & { readonly nullable: true }
	: never;

type Annotations = {
	/** A short label for the field. */
	title?: string;
	/** What the field holds. */
	description?: string;
};

type StringOptions = Annotations & {
	minLength?: number;
	maxLength?: number;
	pattern?: string;
	/** Maximum UTF-8 bytes in the stored string. */
	maxBytes?: number;
};

type NumberOptions = Annotations & { minimum?: number; maximum?: number };

type ListOptions = Annotations & {
	minItems?: number;
	maxItems?: number;
	uniqueItems?: boolean;
};

const ANNOTATIONS = ['title', 'description'] as const;
const STRING = [...ANNOTATIONS, 'minLength', 'maxLength', 'pattern'] as const;
const NUMBER = [...ANNOTATIONS, 'minimum', 'maximum'] as const;
const LIST = [...ANNOTATIONS, 'minItems', 'maxItems', 'uniqueItems'] as const;

/**
 * The options a helper passes to TypeBox, copied.
 *
 * TypeBox merges options over the keywords a constructor sets, so an
 * unchecked `type` or `format` would replace the helper's. An unsupported key
 * throws rather than being dropped: a declaration that asks for something the
 * field will not do should not load.
 */
function supported<TOptions extends object, TKey extends keyof TOptions>(
	helper: string,
	opts: TOptions | undefined,
	keys: readonly TKey[],
): Pick<TOptions, TKey> {
	const picked: Partial<Pick<TOptions, TKey>> = {};
	for (const key of Object.keys(opts ?? {})) {
		if (!(keys as readonly string[]).includes(key))
			throw new TypeError(
				`field.${helper} does not support the '${key}' option`,
			);
		const value = (opts as TOptions)[key as TKey];
		if (value !== undefined) picked[key as TKey] = value;
	}
	return picked as Pick<TOptions, TKey>;
}

const utf8 = new TextEncoder();

/**
 * The native string schema behind `field.string` and `field.reference`.
 *
 * `maxBytes` is a `Type.Refine`, so TypeBox enforces it wherever the schema is
 * checked and reports it among its errors. It is not a keyword: JSON Schema has
 * none for byte length.
 */
function stringSchema(
	helper: string,
	opts: StringOptions | undefined,
	minLength: number,
): TString {
	const { maxBytes, ...keywords } = opts ?? {};
	if (maxBytes !== undefined && !(Number.isInteger(maxBytes) && maxBytes >= 0))
		throw new TypeError(
			`field.${helper} needs maxBytes to be a non-negative integer`,
		);
	const options = supported(helper, keywords, STRING);
	const floor = Math.max(minLength, options.minLength ?? 0);
	const schema = Type.String(
		floor === 0 ? options : { ...options, minLength: floor },
	);
	return maxBytes === undefined
		? schema
		: Type.Refine(
				schema,
				(value) => utf8.encode(value).byteLength <= maxBytes,
				`must be at most ${maxBytes} UTF-8 bytes`,
			);
}

type BrandedString = string & Brand<string>;

/** `TString`, or a schema whose `Static` is the brand `T`. A literal subtype is `never`. */
type StringSchema<T extends string> = string extends T
	? TString
	: T extends BrandedString
		? TUnsafe<T>
		: never;

/**
 * String field with optional brand sugar.
 *
 * - `field.string()`: `Static<>` = `string`.
 * - `field.string<NoteId>()`: `Static<>` = `NoteId`.
 * - `field.string<'draft'>()`: `never`. A literal subtype is not enforced at
 *   runtime; use `field.select(['draft'])`.
 */
function string<T extends string = string>(
	opts?: StringOptions,
): FieldSchema<StringSchema<T>, Meta<'string'>> {
	return attach(stringSchema('string', opts, 0), {
		kind: 'string',
		nullable: false,
	});
}

/**
 * A string that names a row in `table`. Brands like {@link string}.
 *
 * The value is never empty, because the empty string names no row; a larger
 * `minLength` is kept. Whether the target row or table exists is not checked
 * here.
 */
function reference<
	T extends string = string,
	const TTable extends string = string,
>(
	table: TTable,
	opts?: StringOptions,
): FieldSchema<
	StringSchema<T>,
	Meta<'reference', { readonly target: TTable }>
> {
	if (typeof table !== 'string' || table === '')
		throw new TypeError('field.reference needs the name of a table');
	return attach(stringSchema('reference', opts, 1), {
		kind: 'reference',
		nullable: false,
		target: table,
	});
}

/** URL string, checked with TypeBox's `uri` format. */
function url(opts?: Annotations): FieldSchema<TString, Meta<'url'>> {
	return attach(
		Type.String({ ...supported('url', opts, ANNOTATIONS), format: 'uri' }),
		{ kind: 'url', nullable: false },
	);
}

/** Any finite number. */
function number(opts?: NumberOptions): FieldSchema<TNumber, Meta<'number'>> {
	return attach(Type.Number(supported('number', opts, NUMBER)), {
		kind: 'number',
		nullable: false,
	});
}

/** A whole number. A rating is `field.integer({ minimum: 1, maximum: 5 })`. */
function integer(opts?: NumberOptions): FieldSchema<TInteger, Meta<'integer'>> {
	return attach(Type.Integer(supported('integer', opts, NUMBER)), {
		kind: 'integer',
		nullable: false,
	});
}

function boolean(opts?: Annotations): FieldSchema<TBoolean, Meta<'boolean'>> {
	return attach(Type.Boolean(supported('boolean', opts, ANNOTATIONS)), {
		kind: 'boolean',
		nullable: false,
	});
}

/**
 * ISO calendar day, branded as `CalendarDateString`.
 *
 * Carries no time, offset, or time zone. Stored as `YYYY-MM-DD`, which sorts
 * as text.
 */
function date(
	opts?: Annotations,
): FieldSchema<TUnsafe<CalendarDateString>, Meta<'date'>> {
	return attach(
		Type.String({ ...supported('date', opts, ANNOTATIONS), format: 'date' }),
		{ kind: 'date', nullable: false },
	);
}

/**
 * Canonical UTC instant, branded as `InstantString`.
 *
 * Stricter than `field.datetime()`: it requires the fixed-width
 * `YYYY-MM-DDTHH:mm:ss.sssZ` form, which is why text order is chronological
 * order.
 */
function instant(
	opts?: Annotations,
): FieldSchema<TUnsafe<InstantString>, Meta<'instant'>> {
	return attach(
		Type.String({
			...supported('instant', opts, ANNOTATIONS),
			format: 'date-time',
			pattern: INSTANT_STRING_PATTERN,
		}),
		{ kind: 'instant', nullable: false },
	);
}

/**
 * RFC 3339 datetime string, branded as `DateTimeString`. Accepts both `Z` and
 * offset forms.
 */
function datetime(
	opts?: Annotations,
): FieldSchema<TUnsafe<DateTimeString>, Meta<'datetime'>> {
	return attach(
		Type.String({
			...supported('datetime', opts, ANNOTATIONS),
			format: 'date-time',
		}),
		{ kind: 'datetime', nullable: false },
	);
}

/**
 * One frozen copy of an option list. The schema's `enum` and the annotation's
 * `options` are both built from it, so the validator and the widget start out
 * agreeing, and the caller's array is not involved after the call.
 */
function optionList<const T extends readonly string[]>(
	helper: string,
	values: readonly [...T],
): readonly [...T] {
	if (
		!Array.isArray(values) ||
		values.length === 0 ||
		!values.every((value) => typeof value === 'string')
	)
		throw new TypeError(`field.${helper} needs at least one string option`);
	return Object.freeze([...values]) as readonly [...T];
}

/**
 * One of a fixed list of strings. `Static<>` is the literal union
 * (`'a' | 'b'`).
 */
function select<const T extends readonly string[]>(
	values: readonly [...T],
	opts?: Annotations,
): FieldSchema<
	TEnum<[...T]>,
	Meta<'select', { readonly options: readonly [...T] }>
> {
	const options = optionList('select', values);
	return attach(Type.Enum(options, supported('select', opts, ANNOTATIONS)), {
		kind: 'select',
		nullable: false,
		options,
	});
}

/** Any number of a fixed list of strings. `Static<>` is `('a' | 'b')[]`. */
function multiSelect<const T extends readonly string[]>(
	values: readonly [...T],
	opts?: ListOptions,
): FieldSchema<
	TArray<TEnum<[...T]>>,
	Meta<'multiSelect', { readonly options: readonly [...T] }>
> {
	const options = optionList('multiSelect', values);
	return attach(
		Type.Array(Type.Enum(options), supported('multiSelect', opts, LIST)),
		{ kind: 'multiSelect', nullable: false, options },
	);
}

/** A list of free-form strings. `Static<>` is `string[]`. */
function tags(opts?: ListOptions): FieldSchema<TArray<TString>, Meta<'tags'>> {
	return attach(Type.Array(Type.String(), supported('tags', opts, LIST)), {
		kind: 'tags',
		nullable: false,
	});
}

/**
 * The "any JSON value" payload schema: `Static<>` is `JsonValue`.
 *
 * Pass it to `field.json` for a shapeless cell, or nest it:
 * `field.json(Type.Array(jsonValue))`. On its own it is `Type.Any()` and
 * checks nothing; `field.json` is what holds a value to JSON.
 */
export const jsonValue: TUnsafe<JsonValue> = Type.Unsafe<JsonValue>(Type.Any());

const NOT_JSON = 'must be a JSON value';

/** Passes exactly the values that are JSON. */
const JsonGate = Type.Refine(Type.Unknown(), isJsonSafe, NOT_JSON);

/** Passes nothing, and says why: the branch a value takes when it is not JSON. */
const NotJson = Type.Refine(Type.Unknown(), () => false, NOT_JSON);

/**
 * A JSON payload checked against `inner`, edited as JSON.
 *
 * `inner` is any native schema, nested `Type.*` included, and `Static<>` is
 * `Static<inner>`. Another field works too: `field.json(field.select([...]))`
 * keeps the select's check and swaps its editor for the JSON one.
 *
 * The field is the native conditional `{ if: JsonGate, then: inner, else:
 * NotJson }`. `inner` is the `then` branch whole, so its hidden refinements
 * run and a `#/$defs/...` reference inside it still resolves; nothing in it is
 * rewritten.
 *
 * A schema can be structural about what it admits (`Type.Any()` admits a
 * `Date`, `undefined`, and a cycle), and none of those survives being stored,
 * so the gate refuses them whatever `inner` says.
 *
 * The gate has to run BEFORE `inner`, and a conditional is the one native
 * keyword that guarantees it. A recursive `inner` (`Type.Cyclic`) follows a
 * cyclic value until the stack overflows, so it must never see one. A
 * refinement on `inner` runs after `inner`'s own keywords, and `allOf`
 * evaluates every member when it collects errors. `if` decides first in both
 * `Check` and `Errors`, and only then is one branch evaluated.
 *
 * The cost is in the errors: TypeBox reports a failed `then` as one
 * `must match "then" schema` and drops what `inner` said.
 */
function json<S extends TSchema>(
	inner: S,
): FieldSchema<TUnsafe<Static<S>>, Meta<'json'>> {
	if (typeof inner !== 'object' || inner === null || Array.isArray(inner))
		throw new TypeError('field.json needs a schema');
	return attach(
		// biome-ignore lint/suspicious/noThenProperty: `then` is the JSON Schema keyword, and a schema is never awaited
		Type.Unknown({ if: JsonGate, then: inner, else: NotJson }),
		{ kind: 'json', nullable: false },
	);
}

/**
 * A field that may also hold `null`: `Type.Union([inner, Type.Null()])`, with
 * `Static<>` = `Static<inner> | null`, brands included.
 *
 * The annotation is `inner`'s with `nullable` set, so a nullable select keeps
 * its options and a nullable reference its target. A stored field is still
 * always present; `null` is a value, not absence.
 */
function nullable<S extends FieldSchema>(
	inner: S,
): FieldSchema<TUnion<[S, TNull]>, Nullable<S[typeof FIELD_KEYWORD]>> {
	const metadata = fieldMetadataOf(inner);
	if (metadata === null || !isHelperBuilt(inner))
		throw new TypeError('field.nullable needs a field built with field.*');
	return attach<TUnion<[S, TNull]>, FieldMetadata>(
		Type.Union([inner, Type.Null()]),
		{ ...metadata, nullable: true },
	) as FieldSchema<TUnion<[S, TNull]>, Nullable<S[typeof FIELD_KEYWORD]>>;
}

/** The field namespace: every way to declare a field. */
export const field = Object.freeze({
	string,
	reference,
	url,
	number,
	integer,
	boolean,
	date,
	instant,
	datetime,
	select,
	multiSelect,
	tags,
	json,
	nullable,
});
