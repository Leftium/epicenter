/**
 * The `field.*` authoring builders: the CONSTRUCTION half of the closed field
 * vocabulary. `recognize` (in `./field`) is the recognition half. They are
 * inverses over ONE wire-form: serialize a `field.X(...)` schema to its at-rest
 * JSON and `recognize` classifies it back to kind `X`. `field.test.ts` proves
 * the round-trip for every kind.
 *
 * Every builder is a thin composition of native TypeBox constructors that emit
 * the recognized wire-form directly:
 *
 *   field.select(['a','b'])      Type.Enum            -> {enum:['a','b']}        Static = 'a' | 'b'
 *   field.multiSelect(['a','b']) Type.Array(Type.Enum)-> {type:'array',items:{enum:[...]}}
 *   field.tags()                 Type.Array(Type.String) -> {type:'array',items:{type:'string'}}
 *   field.number/integer/boolean Type.Number/Integer/Boolean (full TypeBox JSDoc preserved)
 *
 * `Type.Enum` is the load-bearing choice: in TypeBox v1 it emits the native JSON
 * Schema `enum` keyword, infers `Static` as the literal union, and carries `enum`
 * at the type level, so authoring, recognition, and the Drizzle mirror all read
 * one shape with no `Type.Unsafe` and no value-to-tuple gymnastics.
 *
 * Branding still rides on `Type.Unsafe` for the two cases that need a brand the
 * wire-form cannot express: `field.string<Brand>()` and `field.datetime()`
 * (`Static = DateTimeString`). `Type.Unsafe` decouples the emitted JSON Schema
 * from the inferred `Static<>`.
 *
 * NOTE on at-rest vs in-memory: a live TypeBox schema carries a non-enumerable
 * `~kind` tag that the CLOSED metas reject on a direct `recognize`. That tag is
 * dropped by JSON serialization, so the AT-REST form (what is stored on disk / in
 * Yjs and what `recognize` actually reads) classifies correctly. The round-trip
 * test serializes through JSON to mirror this.
 *
 * Closed sets are STRING-ONLY: `select` / `multiSelect` hold strings, not numbers
 * or booleans. A numeric range is an `integer` with `minimum` / `maximum`, not a
 * select. No emptiness (`nullable`) or arbitrary-`json` builder lives here either:
 * those are SUBSTRATE POLICY the workspace layers on in `column.*`, and matter
 * forbids. The vocabulary itself is policy-free.
 */

import {
	type TArray,
	type TEnum,
	type TSchemaOptions,
	type TString,
	type TStringOptions,
	type TUnsafe,
	Type,
} from 'typebox';
import type { Brand } from 'wellcrafted/brand';
import type { DateTimeString } from './datetime-string';

type BrandedString = string & Brand<string>;

/**
 * String field with optional brand sugar.
 *
 * - `field.string()` -> `TString`, `Static<>` = `string`.
 * - `field.string<NoteId>()` -> `TUnsafe<NoteId>`, `Static<>` = `NoteId`.
 * - `field.string<'draft'>()` -> `never` (compile-time): pretending a literal
 *   subtype is enforced at runtime is dishonest; use `field.select(['draft'])`.
 */
function string<T extends string = string>(
	opts?: TStringOptions,
): string extends T ? TString : T extends BrandedString ? TUnsafe<T> : never {
	return Type.String(opts) as string extends T
		? TString
		: T extends BrandedString
			? TUnsafe<T>
			: never;
}

/**
 * URL string field. A `TString` carrying `format: 'uri'` as a hint, so the schema
 * is self-describing and editor tooling can surface it. Static type is `string`
 * (no brand). When the `uri` format is not registered with the runtime validator,
 * `Value.Check` treats it as a pass, so this never rejects a value the rest of the
 * system would accept.
 */
function url(opts?: TStringOptions): TString {
	return Type.String({ format: 'uri', ...opts });
}

/** Pass-through to `Type.Number`, exposed as `field.number`. */
const number = Type.Number;

/** Pass-through to `Type.Integer`. */
const integer = Type.Integer;

/** Pass-through to `Type.Boolean`. */
const boolean = Type.Boolean;

/**
 * RFC 3339 / ISO 8601 datetime string, branded as `DateTimeString`.
 *
 * Uses TypeBox v1's built-in `date-time` format validator (auto-registered; no
 * `Format.Set` required). Accepts both Z (`...Z`) and offset (`...±HH:MM`) forms.
 * `Type.Unsafe` carries the brand on `Static<>` while emitting the plain
 * `{type:'string', format:'date-time'}` wire-form that `recognize` reads.
 */
function datetime(opts?: TSchemaOptions): TUnsafe<DateTimeString> {
	return Type.Unsafe<DateTimeString>(
		Type.String({ format: 'date-time', ...opts }),
	);
}

/**
 * Closed-set field over a fixed list of string members. A typed narrowing of
 * `Type.Enum`: it emits the native `{enum:[...]}` wire-form `recognize`
 * classifies as `select`, infers `Static` as the literal union (`'a' | 'b'`),
 * and keeps the members on the type so the Drizzle mirror reads them
 * structurally. String-only by design: a numeric range is an `integer` with
 * `minimum` / `maximum`, not a select.
 *
 * The `readonly [...T]` variadic mirrors `Type.Enum`'s own parameter, so the
 * literal tuple flows through with NO cast; the narrower `readonly string[]`
 * bound assigns cleanly because `Type.Enum` accepts a superset. An empty list
 * yields `{enum:[]}`, which `recognize` rejects (the field degrades to raw),
 * matching the uniform "unrecognized schema degrades" contract.
 */
const select: <const T extends readonly string[]>(
	values: readonly [...T],
	opts?: TSchemaOptions,
) => TEnum<[...T]> = Type.Enum;

/**
 * List of closed-set members: an array of the same native `enum` shape `select`
 * emits. Recognizes as `multiSelect`. `Static<>` is the array of the literal
 * union (`('a' | 'b')[]`). Composing the typed `select` (whose declared return
 * threads `T`) keeps this cast-free; the list refinements (`minItems` /
 * `maxItems` / `uniqueItems`) ride on the array via `opts`.
 */
const multiSelect = <const T extends readonly string[]>(
	values: readonly [...T],
	opts?: TSchemaOptions,
): TArray<TEnum<[...T]>> => Type.Array(select(values), opts);

/**
 * List of free-form strings: `{type:'array', items:{type:'string'}}`. Recognizes
 * as `tags`. `Static<>` is `string[]`.
 */
const tags = (opts?: TSchemaOptions) => Type.Array(Type.String(), opts);

/**
 * The `field.*` namespace: the one blessed way to construct a schema in the
 * recognized vocabulary. Each builder emits the wire-form its kind's meta reads,
 * so `recognize` is its inverse. Substrate-only wrappers (`nullable`, `json`,
 * `ianaTimeZone`) are NOT here; the workspace adds them in `column.*`.
 */
export const field = {
	string,
	url,
	number,
	integer,
	boolean,
	datetime,
	select,
	multiSelect,
	tags,
};
