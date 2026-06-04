/**
 * The one truth: a field IS a JSON Schema (the `column.*` subset).
 *
 * Matter stores no `{kind}` descriptor and no `required` flag. Each field in
 * `matter.json` is a plain JSON Schema, the same artifact `column.*` emits, and
 * three pure readers run off it:
 *
 *   deriveKind(schema)         -> which UI cell/editor renders it
 *   Schema.Compile(schema)     -> the validator (conformance)
 *   isNullable(schema)         -> may the value be empty (and, later, SQLite NOT NULL)
 *
 * `kind` is DERIVED from the schema's shape, never stored. This module owns the
 * supported subset of shapes (the schema builders, the kind derivation, and the
 * format registration) so inference and conformance share ONE definition of
 * "what is a url / a datetime": the schema itself. No parallel predicate.
 *
 * We keep the core dependency-light: a local `isNullable` rather than pulling
 * `@epicenter/workspace`, and plain JSON-Schema object literals rather than the
 * `column.*` builders (the at-rest shapes are identical, and these are the only
 * shapes Matter recognizes).
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

/** What `deriveKind` returns: the renderer kind plus the two orthogonal axes. */
export type DerivedKind = {
	/** The kind the UI renders. */
	kind: Kind;
	/** True when the schema admits `null` (the `anyOf`-with-null shape). */
	nullable: boolean;
	/**
	 * For `kind: 'array'`, the element's derived kind (chips render per element).
	 * Undefined for every scalar kind.
	 */
	items?: DerivedKind;
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
 * True when the schema admits `null` via the `anyOf`-with-a-null-branch shape
 * (what `column.nullable` emits). This is the ONE emptiness primitive: a field
 * is "required" iff its schema is NOT nullable. We deliberately do not honor a
 * bare `type: ['string','null']` array here because the supported authoring
 * subset only emits the `anyOf` shape; the matter.json validator rejects the
 * array form so this stays the single recognized representation.
 */
export function isNullable(schema: JsonSchema): boolean {
	const s = shape(schema);
	return Array.isArray(s.anyOf) && s.anyOf.some((b) => shape(b).type === 'null');
}

/**
 * Peel a nullable wrapper down to its single non-null branch. Returns the inner
 * schema and whether a null branch was present. A non-nullable schema is
 * returned unchanged with `nullable: false`.
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
 * KINDS registry in the spec.
 */
function matchKind(inner: JsonSchema): Kind | { array: JsonSchema } {
	const s = shape(inner);
	if (s.enum !== undefined) return 'enum';
	if (s.type === 'boolean') return 'boolean';
	if (s.type === 'integer') return 'integer';
	if (s.type === 'number') return 'number';
	if (s.type === 'string' && s.format === 'uri') return 'url';
	if (s.type === 'string' && s.format === 'date-time') return 'datetime';
	if (s.type === 'string') return 'string';
	if (s.type === 'array' && s.items) return { array: s.items };
	return 'json';
}

/**
 * Derive the UI kind from a schema's shape. Unwrap a nullable wrapper first
 * (carrying the nullable flag), then ordered shape-match, recursing into array
 * items, falling back to `json` for any unrecognized shape.
 */
export function deriveKind(schema: JsonSchema): DerivedKind {
	const { inner, nullable } = unwrapNullable(schema);
	const matched = matchKind(inner);
	if (typeof matched === 'object') {
		return { kind: 'array', nullable, items: deriveKind(matched.array) };
	}
	return { kind: matched, nullable };
}

/**
 * The schema builders for the scalar kinds inference can claim. These are the
 * at-rest `column.*` shapes; inference compiles these and runs `.Check`, so the
 * inferred preview and conformance validate against the IDENTICAL definition and
 * cannot drift. `string` is the floor (always matches) and `enum` is opt-in, so
 * neither is an inference target; they live in `deriveKind`'s recognizer list
 * but not here.
 */
const SCHEMA_FOR: Record<'boolean' | 'integer' | 'number' | 'datetime' | 'url', JsonSchema> = {
	boolean: { type: 'boolean' },
	integer: { type: 'integer' },
	number: { type: 'number' },
	datetime: { type: 'string', format: 'date-time' },
	url: { type: 'string', format: 'uri' },
};

/**
 * The inference lattice as compiled checks, most-specific first. `boolean` and
 * the numeric kinds are gated on the JS type before the schema check (a JSON
 * `true`/number, not a string), so a string can only ever fall to `datetime`,
 * `url`, or the implicit `string` floor. This is the single source of truth the
 * on-ramp invariant rides on:
 *
 *   inferValueKind(v) = k  =>  Schema.Compile(SCHEMA_FOR[k]).Check(v)  is true
 *
 * because `inferValueKind` ASKS that check directly.
 */
// `Validator.Check` reads `this`, so it must be CALLED on the validator, never
// torn off as a bare reference. Wrap each in an arrow that keeps the receiver.
const booleanValidator = Schema.Compile(SCHEMA_FOR.boolean);
const integerValidator = Schema.Compile(SCHEMA_FOR.integer);
const numberValidator = Schema.Compile(SCHEMA_FOR.number);
const dateTimeValidator = Schema.Compile(SCHEMA_FOR.datetime);
const urlValidator = Schema.Compile(SCHEMA_FOR.url);

const checkBoolean = (v: unknown) => booleanValidator.Check(v);
const checkInteger = (v: unknown) => integerValidator.Check(v);
const checkNumber = (v: unknown) => numberValidator.Check(v);
const checkDateTime = (v: unknown) => dateTimeValidator.Check(v);
const checkUrl = (v: unknown) => urlValidator.Check(v);

/**
 * The kind a single value most specifically satisfies, using the compiled
 * schemas (NOT a parallel regex). `string` is the floor that catches everything
 * else. Inference may under-claim to `string`; by construction it never claims a
 * kind whose schema would reject the value.
 */
export function inferValueKind(
	value: unknown,
): 'string' | 'integer' | 'number' | 'boolean' | 'datetime' | 'url' {
	if (checkBoolean(value)) return 'boolean';
	if (checkInteger(value)) return 'integer';
	if (checkNumber(value)) return 'number';
	if (checkDateTime(value)) return 'datetime';
	if (checkUrl(value)) return 'url';
	return 'string';
}
