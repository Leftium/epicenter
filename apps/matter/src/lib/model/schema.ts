/**
 * The one truth: a field IS a JSON Schema (the `column.*` subset).
 *
 * Matter stores no `{kind}` descriptor and no `required` flag. Each field in
 * `matter.json` is a plain JSON Schema, the same artifact `column.*` emits, and
 * two pure readers run off it:
 *
 *   deriveKind(schema)  -> which UI cell/editor renders it, plus whether the
 *                          value may be empty (the `nullable` flag)
 *   compile(schema)     -> the validator (conformance)
 *
 * `kind` and `nullable` are DERIVED from the schema's shape, never stored.
 * `deriveKind` (via `unwrapNullable`) is the SINGLE place the `anyOf`-null shape
 * is detected, so conformance has ONE definition of "what is a url / a datetime /
 * an empty-able field": the schema itself. No parallel predicate. This module is
 * also the ONLY place `typebox` is touched (formats + compile), so the at-rest
 * JSON Schema is the one input the runtime reads.
 *
 * We keep the core dependency-light: plain JSON-Schema object literals rather
 * than the `column.*` builders (the at-rest shapes are identical, and these are
 * the only shapes Matter recognizes).
 */

import { Format } from 'typebox/format';
import * as Schema from 'typebox/schema';

/**
 * A JSON Schema as it sits in `matter.json`: a plain object literal. We do not
 * import TypeBox's `TSchema` here because the at-rest truth is JSON, not a
 * TypeBox value, and `Schema.Compile` validates a plain JSON Schema directly.
 */
export type JsonSchema = Record<string, unknown>;

/**
 * Register the value-semantic formats so `format: 'uri'` / `format: 'date-time'`
 * actually enforce. TypeBox's `FormatRegistry` treats an UNREGISTERED format as
 * "always passes", so without this `column.url` / `column.dateTime` would accept
 * every string and every string would infer as `url`.
 *
 * TypeBox 1.x ships `uri` and `date-time` registered by default, but Matter must
 * not depend on that: we register them explicitly (idempotent) so the contract
 * is owned here, on Matter's path, regardless of registry state. `compile` calls
 * this before the first `Schema.Compile`, so there is no import-time side effect;
 * call it directly only when compiling a schema outside `compile` (e.g. a test).
 */
export function registerFormats(): void {
	Format.Set('uri', Format.IsUri);
	Format.Set('date-time', Format.IsDateTime);
}

/**
 * Compile a stored JSON Schema into a value check. The ONE place `Schema.Compile`
 * is called: it registers the value-semantic formats first (idempotent, so the
 * `uri` / `date-time` checks actually enforce), then preserves the validator's
 * receiver by closing over it rather than tearing `Check` off (it reads `this`).
 */
export function compile(schema: JsonSchema): (value: unknown) => boolean {
	registerFormats();
	const validator = Schema.Compile(schema);
	return (value) => validator.Check(value);
}

type SchemaShape = {
	type?: string | string[];
	format?: string;
	enum?: unknown[];
	anyOf?: JsonSchema[];
	items?: JsonSchema;
};

function shape(schema: JsonSchema): SchemaShape {
	return schema as SchemaShape;
}

/**
 * The recognizers, in PRIORITY order: the first whose `match` passes wins, so the
 * most specific shapes come before the floor. This ordered array is the SINGLE
 * SOURCE of both the matcher (`matchKind` walks it) and the `Kind` union (derived
 * from its entries), so adding a kind is ONE row here, and the type, the
 * recognizer, and the renderer's exhaustiveness guard (which keys off `Kind`) all
 * follow from it.
 *
 * Why an ordered array and not `keyof` an object: matching is order-sensitive
 * (`uri` before bare `string`; every scalar before the `json` floor), and object
 * key order is not a contract. Why matter-local and not `keyof typeof column`: the
 * workspace `column.*` namespace is a DIFFERENT set (it has `literal`/`nullable`
 * and no `array`), and `schema.ts` stays free of the workspace dependency.
 *
 * `json` is the catch-all floor (matches any shape), so `matchKind` always
 * resolves and the union always carries the fallback kind.
 */
const KINDS = [
	{ kind: 'enum', match: (s: SchemaShape) => s.enum !== undefined },
	{ kind: 'boolean', match: (s: SchemaShape) => s.type === 'boolean' },
	{ kind: 'integer', match: (s: SchemaShape) => s.type === 'integer' },
	{ kind: 'number', match: (s: SchemaShape) => s.type === 'number' },
	{
		kind: 'url',
		match: (s: SchemaShape) => s.type === 'string' && s.format === 'uri',
	},
	{
		kind: 'datetime',
		match: (s: SchemaShape) => s.type === 'string' && s.format === 'date-time',
	},
	{ kind: 'string', match: (s: SchemaShape) => s.type === 'string' },
	{
		kind: 'array',
		match: (s: SchemaShape) => s.type === 'array' && s.items !== undefined,
	},
	{ kind: 'json', match: (_s: SchemaShape) => true },
] as const;

/**
 * The closed set of UI kinds, DERIVED from the `KINDS` recognizers (their `kind`
 * keys are the only source). Never stored; computed from a schema's shape. `json`
 * is the floor for any shape outside the recognized subset (a nested object, a
 * mixed union).
 */
export type Kind = (typeof KINDS)[number]['kind'];

/** What `deriveKind` returns: the renderer kind plus the nullable axis. */
export type DerivedKind = {
	/** The kind the UI renders. */
	kind: Kind;
	/** True when the schema admits `null` (the `anyOf`-with-null shape). */
	nullable: boolean;
};

/**
 * Peel a nullable wrapper down to its single non-null branch. Returns the inner
 * schema and whether a null branch was present (the ONE place the `anyOf`-null
 * shape, what `column.nullable` emits, is detected: a field is "required" iff its
 * schema has no null branch). A non-nullable schema is returned unchanged with
 * `nullable: false`. We deliberately do not honor a bare `type: ['string','null']`
 * array because the supported authoring subset only emits the `anyOf` shape; the
 * matter.json validator rejects the array form, so this stays the single
 * recognized representation.
 */
function unwrapNullable(schema: JsonSchema): {
	inner: JsonSchema;
	nullable: boolean;
} {
	const s = shape(schema);
	if (!Array.isArray(s.anyOf)) return { inner: schema, nullable: false };
	const nonNull = s.anyOf.filter((b) => shape(b).type !== 'null');
	const nullable = nonNull.length !== s.anyOf.length;
	// Exactly one non-null branch is the recognized nullable shape; anything else
	// (a real union) is not a kind we render, so leave it for the json fallback.
	if (nonNull.length === 1 && nonNull[0])
		return { inner: nonNull[0], nullable };
	return { inner: schema, nullable };
}

/**
 * Match a NON-nullable scalar/array shape to a kind by walking `KINDS` in
 * priority order; the first recognizer wins. The `json` floor matches any shape,
 * so this always resolves. (An `array` requires a declared `items` schema; its
 * element kind is not derived until a typed-chip renderer needs it.)
 */
function matchKind(inner: JsonSchema): Kind {
	const s = shape(inner);
	const matched = KINDS.find((k) => k.match(s));
	return matched ? matched.kind : 'json';
}

/**
 * Derive the UI kind from a schema's shape. Unwrap a nullable wrapper first
 * (carrying the nullable flag), then ordered shape-match, falling back to `json`
 * for any unrecognized shape.
 */
export function deriveKind(schema: JsonSchema): DerivedKind {
	const { inner, nullable } = unwrapNullable(schema);
	return { kind: matchKind(inner), nullable };
}
