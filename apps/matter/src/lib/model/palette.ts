/**
 * The closed field palette, expressed as a META-SCHEMA (a schema OF schemas).
 *
 * Matter's at-rest truth is a plain JSON Schema per field. This module answers the
 * one question about such a schema, through a single total entry point:
 *
 *   recognize(s) -> the kind whose closed meta matches, or null if `s` is outside
 *                   the palette (the rejection lane that degrades a field to raw).
 *
 * Each kind carries a CLOSED TypeBox object meta-schema (`additionalProperties:
 * false`). Two properties fall out of that closure and they are the whole point:
 *
 *   1. The nine metas are MUTUALLY EXCLUSIVE. A `url` schema carries `format:'uri'`,
 *      which the bare-`string` meta forbids; a `select` schema carries `enum`, which
 *      every scalar meta forbids; a `multiSelect`'s items carry `enum`, which the
 *      `tags` item meta forbids. So at most one meta matches any legal schema, which
 *      means `recognize` needs no priority order and cannot be ambiguous.
 *   2. TYPOS DIE AT THE BOUNDARY. `{type:'strng'}` or `{type:'string', minLgth:1}`
 *      matches no meta, so `recognize` returns null and the field degrades to a raw
 *      column instead of silently rendering as `string`.
 *
 * Every meta reads `{ ...discriminators, ...refinements, ...annotations }`: three
 * buckets with one rule, only the DISCRIMINATORS differ across kinds.
 *
 *   discriminators  type / format / enum / items   the keys recognition reads.
 *   refinements     minLength.. / minimum.. / minItems..   closed per value-domain,
 *                   so a typo'd refinement key still dies, and the value constraint
 *                   rides along for free: a rating is `{type:'integer', minimum:1,
 *                   maximum:5}`, still kind `integer`, still validated, no new kind.
 *   annotations     title / description / default   inert metadata, IDENTICAL on
 *                   every meta. That identity is load-bearing: because the same
 *                   bucket is spread into all nine metas, an annotation can never tip
 *                   which kind matches, which is exactly why the bucket is safe to
 *                   widen. Held to the standard keywords with a real authoring path
 *                   into a `matter.json` field (`title`/`description` from the field
 *                   builders, `default` for a new-row default). `examples`, `$comment`,
 *                   `deprecated`, `readOnly`, `writeOnly`, `$id`, `$schema` are NOT
 *                   admitted: no path today, so a schema carrying one degrades to raw.
 *                   The day a real schema carries one and degrades is the signal to
 *                   add it here, not before.
 *
 * There is NO `nullable` / optional axis and NO `json` kind. Optionality is deleted
 * (every modeled field is required; "must have content" is a value constraint like
 * `minLength`, not a model flag), so a nullable `anyOf`-with-null shape matches no
 * meta. `json` is the rejection lane, not a member of `Kind`: `recognize` returns
 * null.
 *
 * Everything public is DERIVED from the one `PALETTE` array below: `Kind`,
 * `recognize`, `storageOf`, `KINDS`, `META_BY_KIND`. Adding a kind is one row here,
 * plus its widget in the component registry, which the compiler forces.
 *
 * This module also owns the VALUE side of a field schema: `JsonSchema` (its at-rest
 * shape) and `compile` (the single `Schema.Compile` that turns a stored schema into a
 * per-cell validator, registering the value-semantic formats first). So one place
 * answers both readings of a stored schema: "which kind is it" (`recognize`) and "does
 * this value satisfy it" (`compile`).
 */

import { type Static, Type } from 'typebox';
import { Format } from 'typebox/format';
import * as Schema from 'typebox/schema';
import { Value } from 'typebox/value';

/**
 * A field's at-rest JSON Schema in `matter.json`: a plain object literal. The named
 * keys are the ones recognition and the cells READ (`schema.enum` / `schema.items`),
 * typed so they flow without a per-reader cast. The closed shape (no index signature)
 * catches typos; the ONE assertion that a parsed disk object IS this shape lives at the
 * parse boundary in `model.ts`, after `recognize` has accepted it.
 */
export type JsonSchema = {
	type?: string | string[];
	format?: string;
	enum?: unknown[];
	anyOf?: JsonSchema[];
	items?: JsonSchema;
};

/** Reject any property the meta does not explicitly name. The source of mutual exclusivity. */
const CLOSED = { additionalProperties: false } as const;

/**
 * Bucket 3: ANNOTATIONS. Inert standard metadata, whitelisted into EVERY closed meta
 * (identically, so it can never affect discrimination) so carrying one does not open
 * the shape. Held to the keys with a real authoring path into a field: `title` /
 * `description` from the field builders, `default` for a new-row default. `default` is
 * `Unknown` (any JSON value, not constrained to the field's own type; conformance
 * validates cell values, not defaults). Other standard annotations (`examples`,
 * `$comment`, `deprecated`, `readOnly`, `writeOnly`, `$id`, `$schema`) are deliberately
 * NOT admitted, so a schema carrying one degrades to raw until a real case argues it in.
 */
const ANNOT = {
	title: Type.Optional(Type.String()),
	description: Type.Optional(Type.String()),
	default: Type.Optional(Type.Unknown()),
};

/** The value space a closed set (`select` / `multiSelect`) may hold. `Number` covers integers. */
const JsonPrimitive = Type.Union([Type.String(), Type.Number(), Type.Boolean()]);

/** The TS value space of a closed set, mirrored from the {@link JsonPrimitive} schema. */
export type JsonPrimitive = Static<typeof JsonPrimitive>;

/**
 * The closed-set discriminant: a non-empty `enum` of primitives, optionally pinned
 * to a base `type`. Shared by the `select` meta and the `multiSelect` item meta, so
 * the two recognize the same closed-set shape. `enum` is REQUIRED here, which is what
 * keeps `select` mutually exclusive from the scalar kinds (they forbid `enum`).
 */
const enumProps = {
	enum: Type.Array(JsonPrimitive, { minItems: 1 }),
	type: Type.Optional(
		Type.Union([
			Type.Literal('string'),
			Type.Literal('number'),
			Type.Literal('integer'),
		]),
	),
};

/** Item shape for `tags`: a plain string, no annotations. Forbids `enum` (that is `multiSelect`). */
const StringItem = Type.Object({ type: Type.Literal('string') }, CLOSED);

/** Item shape for `multiSelect`: the closed-set discriminant. Requires `enum` (that is not `tags`). */
const SelectItem = Type.Object(enumProps, CLOSED);

/** Bucket 2: string refinements. Closed set, so a typo'd key (`minLgth`) still dies. */
const STRING_REFINE = {
	minLength: Type.Optional(Type.Integer()),
	maxLength: Type.Optional(Type.Integer()),
	pattern: Type.Optional(Type.String()),
};

/** Bucket 2: numeric refinements, shared by `integer` and `number`. */
const NUMBER_REFINE = {
	minimum: Type.Optional(Type.Number()),
	maximum: Type.Optional(Type.Number()),
};

/** Bucket 2: list refinements, shared by `tags` and `multiSelect`. */
const LIST_REFINE = {
	minItems: Type.Optional(Type.Integer()),
	maxItems: Type.Optional(Type.Integer()),
	uniqueItems: Type.Optional(Type.Boolean()),
};

/**
 * The single source of the palette: each row pairs a kind name with its closed
 * meta-schema (recognition + boundary validation) and its SQLite storage class.
 * `Kind`, `Storage`, `recognize`, `storageOf`, `KINDS`, and `META_BY_KIND` all derive
 * from this array, so adding a kind is one row. Order is NOT a contract: the metas are
 * mutually exclusive, so `recognize` returns the same answer regardless of iteration
 * order. Each `meta` reads `{ ...discriminators, ...refinements, ...annotations }`.
 */
const PALETTE = [
	{
		kind: 'select',
		storage: 'TEXT',
		meta: Type.Object({ ...enumProps, ...ANNOT }, CLOSED),
	},
	{
		kind: 'url',
		storage: 'TEXT',
		meta: Type.Object(
			{ type: Type.Literal('string'), format: Type.Literal('uri'), ...ANNOT },
			CLOSED,
		),
	},
	{
		kind: 'datetime',
		storage: 'TEXT',
		meta: Type.Object(
			{
				type: Type.Literal('string'),
				format: Type.Literal('date-time'),
				...ANNOT,
			},
			CLOSED,
		),
	},
	{
		kind: 'integer',
		storage: 'INTEGER',
		meta: Type.Object(
			{ type: Type.Literal('integer'), ...NUMBER_REFINE, ...ANNOT },
			CLOSED,
		),
	},
	{
		kind: 'number',
		storage: 'REAL',
		meta: Type.Object(
			{ type: Type.Literal('number'), ...NUMBER_REFINE, ...ANNOT },
			CLOSED,
		),
	},
	{
		kind: 'boolean',
		storage: 'INTEGER',
		meta: Type.Object({ type: Type.Literal('boolean'), ...ANNOT }, CLOSED),
	},
	{
		kind: 'string',
		storage: 'TEXT',
		meta: Type.Object(
			{ type: Type.Literal('string'), ...STRING_REFINE, ...ANNOT },
			CLOSED,
		),
	},
	{
		kind: 'multiSelect',
		storage: 'TEXT',
		meta: Type.Object(
			{
				type: Type.Literal('array'),
				items: SelectItem,
				...LIST_REFINE,
				...ANNOT,
			},
			CLOSED,
		),
	},
	{
		kind: 'tags',
		storage: 'TEXT',
		meta: Type.Object(
			{
				type: Type.Literal('array'),
				items: StringItem,
				...LIST_REFINE,
				...ANNOT,
			},
			CLOSED,
		),
	},
] as const;

/** The closed set of field kinds, DERIVED from the palette. `json` is not a member. */
export type Kind = (typeof PALETTE)[number]['kind'];

/** The SQLite storage classes a kind can map to. */
type Storage = (typeof PALETTE)[number]['storage'];

/**
 * The one classifier: the kind whose closed meta matches `schema`, or `null` when
 * `schema` is outside the palette (the rejection lane that degrades a field to raw).
 * One pass over the metas, no gate to forget and no throw-contract to violate, so the
 * boundary in `model.ts` reads `null` directly. Because the metas are mutually
 * exclusive, exactly one matches any legal schema, so there is no priority order.
 */
export function recognize(schema: unknown): Kind | null {
	return PALETTE.find((entry) => Value.Check(entry.meta, schema))?.kind ?? null;
}

/** The SQLite storage class for a kind. Total: `kind` is one of the palette kinds. */
export function storageOf(kind: Kind): Storage {
	const entry = PALETTE.find((p) => p.kind === kind);
	if (!entry)
		throw new Error(`storageOf called with a non-palette kind: ${kind}`);
	return entry.storage;
}

/**
 * The closed-set options a `select` or `multiSelect` field offers, read off its stored
 * schema (`enum` for `select`, `items.enum` for `multiSelect`). The palette meta proved
 * at the boundary that these are a non-empty array of primitives, so the cast is honest;
 * the typed array is what the select cells render instead of reaching into `schema.enum`
 * (an `unknown[]`). Every other kind carries no options and returns `[]`. Takes the
 * structural slice it needs (`kind` + `schema`), not `Field`, so `palette` stays free of
 * a `model` import (`model` already imports `palette`).
 */
export function optionsOf(field: { kind: Kind; schema: JsonSchema }): JsonPrimitive[] {
	switch (field.kind) {
		case 'select':
			return (field.schema.enum ?? []) as JsonPrimitive[];
		case 'multiSelect':
			return (field.schema.items?.enum ?? []) as JsonPrimitive[];
		default:
			return [];
	}
}

/** Every kind in the palette, in declaration order. The catalog, for tests and tooling. */
export const KINDS = PALETTE.map((p) => p.kind) as readonly Kind[];

/**
 * The per-kind metas, exposed so a test can prove the discrimination invariant
 * (every legal schema matches EXACTLY ONE meta). Keyed by kind for readable failures.
 */
export const META_BY_KIND = Object.fromEntries(
	PALETTE.map((p) => [p.kind, p.meta]),
) as Record<Kind, (typeof PALETTE)[number]['meta']>;

/**
 * Compile a stored JSON Schema into a value check: the ONE place `Schema.Compile` is
 * called. It closes over the validator rather than tearing `Check` off (it reads
 * `this`). `recognize` decides WHICH kind a schema is; `compile` decides whether a
 * VALUE satisfies it.
 *
 * The `Format.Set` calls register the value-semantic formats and run on every compile
 * (idempotent, no import-time side effect): TypeBox treats an UNREGISTERED format as
 * "always passes", so without them every string would satisfy `url` / `datetime`.
 */
export function compile(schema: JsonSchema): (value: unknown) => boolean {
	Format.Set('uri', Format.IsUri);
	Format.Set('date-time', Format.IsDateTime);
	const validator = Schema.Compile(schema);
	return (value) => validator.Check(value);
}
