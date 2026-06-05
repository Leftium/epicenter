/**
 * The one truth: a field IS a plain JSON Schema, in Matter's CLOSED palette.
 *
 * Matter stores no `{kind}` descriptor and no `required` flag. Each field in
 * `matter.json` is a plain JSON-Schema object literal, and two pure readers run
 * off it:
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
 * The recognized shapes are Matter's OWN dialect, not whatever `column.*` (the
 * workspace authoring sugar) emits: Matter's `select` reads the native `enum`
 * keyword, and `tags` / `multiSelect` have no `column.*` counterpart. The dialects
 * overlap on scalars but are not the same artifact, and Matter consumes neither
 * `column.*` nor `typebox`'s `TSchema` type. Any shape outside the recognized
 * palette derives to `json` and is rejected to the raw view.
 */

import { Format } from 'typebox/format';
import * as Schema from 'typebox/schema';

/**
 * A JSON Schema as it sits in `matter.json`: a plain object literal. We do not
 * import TypeBox's `TSchema` here because the at-rest truth is JSON, not a
 * TypeBox value, and `Schema.Compile` validates a plain JSON Schema directly.
 *
 * The keys are exactly the ones the recognizers and the cells READ, typed so they
 * flow without a per-reader cast: `deriveKind` walks `type`/`format`/`enum`/
 * `anyOf`/`items` directly, and a cell reads `schema.enum` / `schema.items` with
 * no `as`. The shape is CLOSED (no index signature): a stored schema may carry
 * other JSON-Schema keys on disk (a `title`, a future `x:widget` hint), but
 * nothing here reads them, so leaving them off the type catches a typo instead of
 * widening it to `unknown`. `Schema.Compile` still accepts the whole object (it
 * takes the value, not these keys). The ONE assertion that a parsed disk object IS
 * this shape lives at the parse boundary in `model.ts`; everything downstream is
 * cast-free.
 */
export type JsonSchema = {
	type?: string | string[];
	format?: string;
	enum?: unknown[];
	anyOf?: JsonSchema[];
	items?: JsonSchema;
};

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

/**
 * The recognizers, in PRIORITY order: the first whose `match` passes wins, so the
 * most specific shapes come before the floor. This ordered array is the SINGLE
 * SOURCE of both the matcher (`deriveKind` walks it) and the `Kind` union (derived
 * from its entries), so adding a kind is ONE row here, and the type, the
 * recognizer, and the renderer's exhaustiveness guard (which keys off `Kind`) all
 * follow from it.
 *
 * The palette is a CLOSED set of field kinds (a Notion-style menu), not an open
 * TypeBox composition. There is no general `array` kind: the only recognized
 * multi-value shapes are `multiSelect` (an array of a closed `enum` set) and
 * `tags` (an array of free strings). An array of anything else (objects, mixed
 * items, nested arrays) matches no recognizer and falls to the `json` floor, which
 * `model.ts` rejects to the raw view. That refusal is what keeps every kind flat:
 * no kind contains another kind, so `deriveKind` never recurses.
 *
 * Why an ordered array and not `keyof` an object: matching is order-sensitive
 * (`uri` before bare `string`; `multiSelect` before `tags` so an enum array isn't
 * read as free tags; every recognizer before the `json` floor), and object key
 * order is not a contract.
 *
 * `json` is the catch-all floor (matches any shape), so `deriveKind` always
 * resolves and the union always carries the fallback kind.
 */
const KINDS = [
	{ kind: 'select', match: (s: JsonSchema) => s.enum !== undefined },
	{ kind: 'boolean', match: (s: JsonSchema) => s.type === 'boolean' },
	{ kind: 'integer', match: (s: JsonSchema) => s.type === 'integer' },
	{ kind: 'number', match: (s: JsonSchema) => s.type === 'number' },
	{
		kind: 'url',
		match: (s: JsonSchema) => s.type === 'string' && s.format === 'uri',
	},
	{
		kind: 'datetime',
		match: (s: JsonSchema) => s.type === 'string' && s.format === 'date-time',
	},
	{ kind: 'string', match: (s: JsonSchema) => s.type === 'string' },
	{
		kind: 'multiSelect',
		match: (s: JsonSchema) => s.type === 'array' && s.items?.enum !== undefined,
	},
	{
		kind: 'tags',
		match: (s: JsonSchema) => s.type === 'array' && s.items?.type === 'string',
	},
	{ kind: 'json', match: (_s: JsonSchema) => true },
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
	if (!Array.isArray(schema.anyOf)) return { inner: schema, nullable: false };
	const branches = schema.anyOf;
	const nonNull = branches.filter((b) => b.type !== 'null');
	const nullable = nonNull.length !== branches.length;
	// Exactly one non-null branch is the recognized nullable shape; anything else
	// (a real union) is not a kind we render, so leave it for the json fallback.
	if (nonNull.length === 1 && nonNull[0])
		return { inner: nonNull[0], nullable };
	return { inner: schema, nullable };
}

/**
 * Derive the UI kind from a schema's shape. Unwrap a nullable wrapper first
 * (carrying the nullable flag), then walk `KINDS` in priority order; the first
 * recognizer wins. The `json` floor matches any shape, so this always resolves.
 * The list kinds (`multiSelect`, `tags`) match on their `items` shape alone, so
 * no element kind is ever recursively derived.
 */
export function deriveKind(schema: JsonSchema): DerivedKind {
	const { inner, nullable } = unwrapNullable(schema);
	const kind = KINDS.find((k) => k.match(inner))?.kind ?? 'json';
	return { kind, nullable };
}
