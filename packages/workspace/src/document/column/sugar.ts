/**
 * The `column.*` sugar layer.
 *
 * Optional ergonomics over raw TypeBox. Three helpers add behavior (brand
 * sugar on `string<T>`, the `JsonValue` gate on `json<T>`, composition in
 * `nullable`); two helpers (`dateTime`, `ianaTimeZone`) wrap branded-string
 * patterns; five helpers (`number`, `integer`, `boolean`, `literal`, `enum`)
 * are pass-through re-exports of `Type.X` so autocomplete on `column.` lists
 * the entire SQLite-safe constructor menu in one namespace.
 *
 * Users may freely mix `column.X()` and raw `Type.X()`; the `FlatJsonTSchema`
 * constraint enforces safety regardless of which call site produced the
 * schema.
 */

import {
	Type,
	type Static,
	type TLiteral,
	type TLiteralValue,
	type TNull,
	type TSchema,
	type TString,
	type TUnion,
	type TUnsafe,
} from 'typebox';
import { Format } from 'typebox/format';
import type { Brand } from 'wellcrafted/brand';
import type { JsonValue } from 'wellcrafted/json';
import { DateTimeString } from '../../shared/datetime-string';
import {
	IanaTimeZone,
	IANA_TIME_ZONE_FORMAT,
} from '../../shared/iana-time-zone';
import type { NumberOpts, SchemaMetadata, StringOpts } from './types';

type BrandedString = string & Brand<string>;

if (!Format.Has(IANA_TIME_ZONE_FORMAT)) {
	Format.Set(IANA_TIME_ZONE_FORMAT, (value) => IanaTimeZone.is(value));
}

/**
 * String column with optional brand sugar.
 *
 * - `column.string()` → `TString`, `Static<>` = `string`.
 * - `column.string<NoteId>()` → `TUnsafe<NoteId>`, `Static<>` = `NoteId`.
 * - `column.string<'draft'>()` → `never` (compile-time): pretending a literal
 *   subtype is enforced at runtime is dishonest; use `column.literal('draft')`
 *   instead.
 */
export function string<T extends string = string>(
	opts?: StringOpts,
): string extends T
	? TString
	: T extends BrandedString
		? TUnsafe<T>
		: never {
	const schema = Type.String(opts as StringOpts);
	return schema as string extends T
		? TString
		: T extends BrandedString
			? TUnsafe<T>
			: never;
}

/**
 * Number column. Pass-through to `Type.Number`, exposed for autocomplete
 * discoverability.
 */
export function number(opts?: NumberOpts): ReturnType<typeof Type.Number> {
	return Type.Number(opts);
}

/**
 * Integer column. Pass-through to `Type.Integer`.
 */
export function integer(opts?: NumberOpts): ReturnType<typeof Type.Integer> {
	return Type.Integer(opts);
}

/**
 * Boolean column. Pass-through to `Type.Boolean`.
 */
export function boolean(
	opts?: SchemaMetadata,
): ReturnType<typeof Type.Boolean> {
	return Type.Boolean(opts);
}

/**
 * Literal column. Pass-through to `Type.Literal`. Primary use: `_v` markers
 * via `column.literal(1)`.
 */
export function literal<V extends TLiteralValue>(
	value: V,
	opts?: SchemaMetadata,
): TLiteral<V> {
	return Type.Literal(value, opts);
}

/**
 * Enum-of-literals column. Produces `Type.Union<TLiteral[]>` (anyOf-of-const).
 * The SQLite materializer's `deriveCheck` emits this shape as
 * `col IN ('a', 'b')`.
 *
 * `Type.Enum` (`~kind: 'Enum'`) is rejected by `FlatJsonTSchema` in favor of
 * this shape so the CHECK generator has one shape to walk.
 */
export function enum_<const T extends readonly (string | number)[]>(
	values: T,
	opts?: SchemaMetadata,
): TUnion<TLiteral<T[number]>[]> {
	const members = values.map((v) => Type.Literal(v));
	return Type.Union(members, opts) as TUnion<TLiteral<T[number]>[]>;
}

/**
 * JSON-encoded TEXT column with a required runtime schema and a compile-time
 * `JsonValue` gate.
 *
 * The schema argument is required by design: no implicit `Type.Any()`. A
 * caller writing `column.json<{x: number}>()` gets a TS error pointing at the
 * missing argument, instead of a silent runtime no-op where every value
 * passes `Value.Check`.
 *
 * The type parameter `T` is constrained to `JsonValue` (from
 * `wellcrafted/json`), which rejects `Date`, `bigint`, optional keys widening
 * to `T | undefined` under loose `exactOptionalPropertyTypes`, and any other
 * non-JSON shape at the type level.
 */
export function json<T extends JsonValue>(
	schema: TSchema,
	opts?: SchemaMetadata,
): TUnsafe<T> {
	const wrapped = opts ? { ...schema, ...opts } : schema;
	return Type.Unsafe<T>(wrapped);
}

/**
 * Composition sugar: `Type.Union([schema, Type.Null()])`. Reads as "nullable
 * inner" instead of constructing the union by hand. Matches TypeBox issue
 * #989 guidance on nullability.
 */
export function nullable<S extends TSchema>(schema: S): TUnion<[S, TNull]> {
	return Type.Union([schema, Type.Null()]);
}

/**
 * RFC 3339 / ISO 8601 datetime string, branded as `DateTimeString`.
 *
 * Uses TypeBox v1's built-in `date-time` format validator (auto-registered;
 * no `Format.Set` required). Accepts both Z (`...Z`) and offset
 * (`...±HH:MM`) forms.
 *
 * **Writing convention.** Lex-sort across rows is chronological iff every
 * writer emits the Z form. `new Date().toISOString()` and
 * `Temporal.Now.instant().toString()` both do this. We document the
 * convention in the brand JSDoc but do not enforce it at the schema layer.
 *
 * Pair with `column.ianaTimeZone()` as a separate field if you need the
 * originating zone (calendar events, reminders): see the
 * `<field>` + `<field>Zone` naming convention.
 */
export function dateTime(opts?: SchemaMetadata): TUnsafe<DateTimeString> {
	return Type.Unsafe<DateTimeString>(
		Type.String({ format: 'date-time', ...opts }),
	);
}

/**
 * IANA timezone identifier, branded as `IanaTimeZone`.
 *
 * The `iana-time-zone` format is registered once at module load via
 * `Format.Set`, using `Intl.DateTimeFormat` as the source of truth (any zone
 * the runtime accepts is valid; any zone it rejects is not). No hand-tuned
 * regex.
 */
export function ianaTimeZone(
	opts?: SchemaMetadata,
): TUnsafe<IanaTimeZone> {
	return Type.Unsafe<IanaTimeZone>(
		Type.String({ format: IANA_TIME_ZONE_FORMAT, ...opts }),
	);
}

/**
 * The `column.*` sugar namespace. `column.X(opts)` returns a vanilla TypeBox
 * `TSchema` (identical to what `Type.X(opts)` returns; the helpers don't wrap
 * or annotate). Each schema *is* the JSON Schema, the validator input, and
 * the static-type carrier.
 */
export const column = {
	string,
	number,
	integer,
	boolean,
	literal,
	enum: enum_,
	json,
	nullable,
	dateTime,
	ianaTimeZone,
};

/**
 * `Static<>` shorthand that mirrors TypeBox's `Static<S>` for ergonomics.
 * Exported alongside the `column` namespace so consumers can read row types
 * out of column maps without a separate TypeBox import.
 */
export type Infer<S extends TSchema> = Static<S>;
