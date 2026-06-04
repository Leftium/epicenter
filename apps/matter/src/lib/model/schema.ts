/**
 * The one truth: a field IS a JSON Schema (the `column.*` subset).
 *
 * Matter stores no `{kind}` descriptor and no `required` flag. Each field in
 * `matter.json` is a plain JSON Schema, the same artifact `column.*` emits, and
 * two pure readers run off it:
 *
 *   deriveKind(schema)         -> which UI cell/editor renders it, plus whether
 *                                 the value may be empty (the `nullable` flag)
 *   Schema.Compile(schema)     -> the validator (conformance)
 *
 * `kind` and `nullable` are DERIVED from the schema's shape, never stored.
 * `deriveKind` (via `unwrapNullable`) is the SINGLE place the `anyOf`-null shape
 * is detected, so conformance has ONE definition of "what is a url / a datetime /
 * an empty-able field": the schema itself. No parallel predicate.
 *
 * We keep the core dependency-light: plain JSON-Schema object literals rather
 * than the `column.*` builders (the at-rest shapes are identical, and these are
 * the only shapes Matter recognizes).
 */

import { Format } from 'typebox/format';

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
 * is owned here, on Matter's path, regardless of registry state. Call once, at
 * module load, before any `Schema.Compile`.
 */
export function registerFormats(): void {
	Format.Set('uri', Format.IsUri);
	Format.Set('date-time', Format.IsDateTime);
}

registerFormats();

/**
 * The closed set of column kinds the UI knows how to render. Derived from a
 * schema's shape, never stored. `json` is the read-only fallback for any shape
 * outside the recognized subset (a nested object, a mixed union).
 */
export type Kind =
	| 'string'
	| 'integer'
	| 'number'
	| 'boolean'
	| 'datetime'
	| 'url'
	| 'enum'
	| 'array'
	| 'json';

/** What `deriveKind` returns: the renderer kind plus the nullable axis. */
export type DerivedKind = {
	/** The kind the UI renders. */
	kind: Kind;
	/** True when the schema admits `null` (the `anyOf`-with-null shape). */
	nullable: boolean;
};

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
 * Match a NON-nullable scalar/array shape to a kind. Ordered: the most specific
 * shape wins, `string` is the floor, `json` is the catch-all. Mirrors the
 * KINDS registry in the spec. An array still requires a declared `items` schema
 * to be recognized; its element kind is not derived until a typed-chip renderer
 * needs it (it arrives with that renderer, not as a half-built field here).
 */
function matchKind(inner: JsonSchema): Kind {
	const s = shape(inner);
	if (s.enum !== undefined) return 'enum';
	if (s.type === 'boolean') return 'boolean';
	if (s.type === 'integer') return 'integer';
	if (s.type === 'number') return 'number';
	if (s.type === 'string' && s.format === 'uri') return 'url';
	if (s.type === 'string' && s.format === 'date-time') return 'datetime';
	if (s.type === 'string') return 'string';
	if (s.type === 'array' && s.items) return 'array';
	return 'json';
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
