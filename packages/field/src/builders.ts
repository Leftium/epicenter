/**
 * The `field.*` authoring builders: the CONSTRUCTION half of the closed field
 * vocabulary. `recognize` (in `./field`) is the recognition half. They are
 * inverses over ONE wire-form: serialize a `field.X(...)` schema to its at-rest
 * JSON and `recognize` classifies it back to kind `X`. `field.test.ts` proves
 * the round-trip for every kind.
 *
 * Branding rides on `Type.Unsafe`, which decouples the emitted JSON Schema
 * (wire-form) from the inferred `Static<>`:
 *
 *   field.datetime()            wire {type:'string', format:'date-time'}   Static = DateTimeString
 *   field.select(['a','b'])     wire {type:'string', enum:['a','b']}       Static = 'a' | 'b'
 *   field.string<NoteId>()      wire {type:'string'}                       Static = NoteId
 *
 * The plain scalars (`number`, `integer`, `boolean`) alias `Type.X` directly, so
 * they keep TypeBox's full JSDoc / signature / overloads (single source of truth)
 * and emit the exact wire-form their meta recognizes.
 *
 * NOTE on at-rest vs in-memory: a live TypeBox schema carries a non-enumerable
 * `~kind` tag that the CLOSED metas reject on a direct `recognize`. That tag is
 * dropped by JSON serialization, so the AT-REST form (what is stored on disk / in
 * Yjs and what `recognize` actually reads) classifies correctly. The round-trip
 * test serializes through JSON to mirror this.
 *
 * No emptiness (`nullable`) or arbitrary-`json` builder lives here: those are
 * SUBSTRATE POLICY the workspace layers on in `column.*`, and matter forbids. The
 * vocabulary itself is policy-free.
 */

import {
	type Static,
	type TSchema,
	type TSchemaOptions,
	type TString,
	type TStringOptions,
	type TUnsafe,
	Type,
} from 'typebox';
import type { Brand } from 'wellcrafted/brand';
import type { DateTimeString } from './datetime-string';

type BrandedString = string & Brand<string>;

/** The primitive members a closed set (`select` / `multiSelect`) may hold. */
type EnumValue = string | number | boolean;

/**
 * The optional base `type` pin for a closed set, derived from its members so the
 * emitted wire-form matches what `recognize` reads: all-string -> `'string'`,
 * all-integer -> `'integer'`, all-number -> `'number'`. Mixed or boolean members
 * omit the pin (the `select`/`multiSelect` metas leave `type` optional, so the
 * shape still recognizes).
 */
function enumBaseType(
	values: readonly EnumValue[],
): 'string' | 'number' | 'integer' | undefined {
	if (values.every((v) => typeof v === 'string')) return 'string';
	if (values.every((v) => typeof v === 'number')) {
		return values.every((v) => Number.isInteger(v)) ? 'integer' : 'number';
	}
	return undefined;
}

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
 * Closed-set field over a fixed list of primitive members. Emits the NATIVE
 * `enum` wire-form (`{type, enum:[...]}`), the shape `recognize` classifies as
 * `select`. `Type.Unsafe` carries the literal union on `Static<>` (`'a' | 'b'`)
 * while the wire stays a plain JSON Schema enum.
 */
function select<const T extends readonly EnumValue[]>(
	values: T,
	opts?: TSchemaOptions,
): TUnsafe<T[number]> {
	if (values.length === 0) {
		throw new Error('field.select requires at least one value');
	}
	const base = enumBaseType(values);
	return Type.Unsafe<T[number]>({
		...opts,
		...(base ? { type: base } : {}),
		enum: [...values],
	});
}

/**
 * List of closed-set members: an array whose items are the same native `enum`
 * shape `select` emits. Recognizes as `multiSelect`. `Static<>` is the array of
 * the literal union (`('a' | 'b')[]`).
 */
function multiSelect<const T extends readonly EnumValue[]>(
	values: T,
	opts?: TSchemaOptions,
): TUnsafe<T[number][]> {
	if (values.length === 0) {
		throw new Error('field.multiSelect requires at least one value');
	}
	const base = enumBaseType(values);
	return Type.Unsafe<T[number][]>({
		...opts,
		type: 'array',
		items: { ...(base ? { type: base } : {}), enum: [...values] },
	});
}

/**
 * List of free-form strings: `{type:'array', items:{type:'string'}}`. Recognizes
 * as `tags`. `Static<>` is `string[]`.
 */
function tags(opts?: TSchemaOptions): TUnsafe<string[]> {
	return Type.Unsafe<string[]>({
		...opts,
		type: 'array',
		items: { type: 'string' },
	});
}

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

/**
 * `Static<>` shorthand that mirrors TypeBox's `Static<S>` for ergonomics, so
 * consumers can read a value type out of a `field.*` schema without a separate
 * TypeBox import.
 */
export type Infer<S extends TSchema> = Static<S>;
