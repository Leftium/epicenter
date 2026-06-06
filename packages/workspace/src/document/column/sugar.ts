/**
 * The `column.*` sugar layer: the SQLite-safe authoring menu for `defineTable`.
 *
 * `column` is a THIN extension of the shared `field.*` vocabulary
 * (`@epicenter/field`). The portable field kinds are re-exported straight from
 * the leaf, so authoring (`column.*`) and recognition (`recognize`) derive from
 * one vocabulary and round-trip by construction:
 *
 *   column.string  = field.string    column.number  = field.number
 *   column.url     = field.url        column.integer = field.integer
 *   column.dateTime= field.datetime   column.boolean = field.boolean
 *
 * On top of the leaf, the workspace adds its SUBSTRATE POLICY: builders the
 * shared vocabulary deliberately omits because emptiness and arbitrary JSON are
 * per-substrate decisions, not part of the closed field set.
 *
 * - `nullable(inner)` — `Type.Union([inner, Type.Null()])`, the emptiness policy
 *   (matter forbids it; the workspace allows it).
 * - `json<T extends JsonValue>(schema)` — arbitrary JSON TEXT cell, the
 *   workspace escape hatch (matter rejects this shape into its raw lane).
 * - `ianaTimeZone()` — a brand builder with no matter kind (`iana-time-zone`
 *   format, brand `IanaTimeZone`; registered once at module load).
 * - `literal` — `Type.Literal` pass-through for literal-valued columns.
 * - `enum([...])` — enum-of-literals as a `Type.Union<TLiteral[]>`
 *   (`anyOf`-of-`const`). This is the ONE builder whose wire-form has not yet
 *   converged onto the shared `field.select` native `enum`; that switch is the
 *   enum migration phase.
 *
 * `column` is the only builder export (the `Infer` type aside): the builders are
 * reachable solely as `column.X`, so there is one blessed way to construct a
 * column. Users may freely mix `column.X()` and raw `Type.X()`; the
 * `FlatJsonTSchema` constraint enforces safety regardless of which call site
 * produced the schema.
 */

import {
	type Static,
	type TLiteral,
	type TLiteralValue,
	type TNull,
	type TSchema,
	type TSchemaOptions,
	type TUnion,
	type TUnsafe,
	Type,
} from 'typebox';
import { Format } from 'typebox/format';
import { field } from '@epicenter/field';
import type { JsonValue } from 'wellcrafted/json';
import {
	IANA_TIME_ZONE_FORMAT,
	IanaTimeZone,
} from '../../shared/iana-time-zone';
import type { ColumnError } from './constraint';

// Register the IANA timezone format once at module load. Skip if another
// caller already registered it (idempotent under hot-reload / repeated
// module evaluation).
if (!Format.Has(IANA_TIME_ZONE_FORMAT)) {
	Format.Set(IANA_TIME_ZONE_FORMAT, (value) => IanaTimeZone.is(value));
}

/**
 * Pass-through to `Type.Literal`. Use for literal-valued column shapes.
 * (Version discriminators are now library-managed via `defineTable`'s tuple
 * position; do not declare `_v` as a column.)
 */
const literal = Type.Literal;

type EnumMembers<T extends readonly TLiteralValue[]> = [
	TLiteral<T[number] & TLiteralValue>,
	...TLiteral<T[number] & TLiteralValue>[],
];

/**
 * Enum-of-literals column. Produces `Type.Union<TLiteral[]>` (anyOf-of-const).
 * The SQLite materializer's `deriveCheck` emits this shape as
 * `col IN ('a', 'b')`.
 *
 * `Type.Enum` (`~kind: 'Enum'`) is rejected by `FlatJsonTSchema` in favor of
 * this shape so the CHECK generator has one shape to walk.
 *
 * This is the lone builder still on the legacy `anyOf`-of-`const` wire-form; the
 * shared `field.select` emits native `enum`. The convergence onto native `enum`
 * (and the matching `deriveCheck`/stored-schema migration) is the enum
 * migration phase; until then `column.enum` stays source-compatible.
 */
function enum_<const T extends readonly TLiteralValue[]>(
	values: T,
	opts?: TSchemaOptions,
): TUnion<EnumMembers<T>> {
	if (values.length === 0) {
		throw new Error('column.enum requires at least one value');
	}
	const members = values.map((v) => Type.Literal(v));
	return Type.Union(members, opts) as TUnion<EnumMembers<T>>;
}

/**
 * JSON-encoded TEXT column. The TypeScript type derives from `Static<S>`, so
 * the static and runtime sides are guaranteed to agree (no free `<T>`
 * generic that could drift from the schema you actually pass).
 *
 * The schema argument is required: no implicit `Type.Any()`. The
 * `JsonValue` gate runs on `Static<S>` and surfaces as a readable type error
 * if the schema admits non-JSON shapes (`Date`, `bigint`, `undefined`,
 * optional keys widened under loose `exactOptionalPropertyTypes`).
 *
 * @example
 * ```ts
 * column.json(Type.Array(Type.String()))          // Static = string[]
 * column.json(Type.Object({ x: Type.Number() }))  // Static = { x: number }
 * ```
 */
function json<S extends TSchema>(
	schema: S,
	opts?: TSchemaOptions,
): TUnsafe<
	Static<S> extends JsonValue
		? Static<S>
		: ColumnError<`column.json schema must produce a JSON-safe Static<> value (got a shape containing Date, bigint, undefined, or optional keys widened to ' | undefined').`>
> {
	return Type.Unsafe(opts ? { ...schema, ...opts } : schema) as TUnsafe<
		Static<S> extends JsonValue
			? Static<S>
			: ColumnError<`column.json schema must produce a JSON-safe Static<> value (got a shape containing Date, bigint, undefined, or optional keys widened to ' | undefined').`>
	>;
}

/**
 * Composition sugar: `Type.Union([schema, Type.Null()])`. Reads as "nullable
 * inner" instead of constructing the union by hand. Matches TypeBox issue #989
 * guidance on nullability.
 */
function nullable<S extends TSchema>(schema: S): TUnion<[S, TNull]> {
	return Type.Union([schema, Type.Null()]);
}

/**
 * IANA timezone identifier, branded as `IanaTimeZone`.
 *
 * The `iana-time-zone` format is registered once at module load via
 * `Format.Set`, using `Intl.DateTimeFormat` as the source of truth (any zone
 * the runtime accepts is valid; any zone it rejects is not). No hand-tuned
 * regex.
 */
function ianaTimeZone(opts?: TSchemaOptions): TUnsafe<IanaTimeZone> {
	return Type.Unsafe<IanaTimeZone>(
		Type.String({ format: IANA_TIME_ZONE_FORMAT, ...opts }),
	);
}

/**
 * The `column.*` namespace: the shared `field.*` vocabulary plus the workspace's
 * substrate-only wrappers. `column.X(opts)` returns a vanilla TypeBox `TSchema`;
 * each schema *is* the JSON Schema, the validator input, and the static-type
 * carrier. Autocomplete on `column.` lists the entire SQLite-safe constructor
 * menu.
 */
export const column = {
	string: field.string,
	url: field.url,
	number: field.number,
	integer: field.integer,
	boolean: field.boolean,
	dateTime: field.datetime,
	literal,
	enum: enum_,
	json,
	nullable,
	ianaTimeZone,
};

/**
 * `Static<>` shorthand that mirrors TypeBox's `Static<S>` for ergonomics.
 * Exported alongside the `column` namespace so consumers can read row types
 * out of column maps without a separate TypeBox import.
 */
export type Infer<S extends TSchema> = Static<S>;
