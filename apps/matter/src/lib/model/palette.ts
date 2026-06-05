/**
 * The closed field palette, expressed as a META-SCHEMA (a schema OF schemas).
 *
 * Matter's at-rest truth is a plain JSON Schema per field. This module is the ONE
 * place that answers two questions about such a schema:
 *
 *   isFieldSchema(s)  -> is this a legal member of the closed palette?   (the boundary)
 *   deriveKind(s)     -> which of the nine kinds is it?                   (total, post-boundary)
 *
 * Each kind carries a CLOSED TypeBox object meta-schema (`additionalProperties:
 * false`). Two properties fall out of that closure and they are the whole point:
 *
 *   1. The nine metas are MUTUALLY EXCLUSIVE. A `url` schema carries `format:'uri'`,
 *      which the bare-`string` meta forbids; a `select` schema carries `enum`, which
 *      every scalar meta forbids; a `multiSelect`'s items carry `enum`, which the
 *      `tags` item meta forbids. So at most one meta matches any legal schema, which
 *      means `deriveKind` needs no priority order and cannot be ambiguous.
 *   2. TYPOS DIE AT THE BOUNDARY. `{type:'strng'}` or `{type:'string', minLgth:1}`
 *      matches no meta, so `isFieldSchema` returns false and the field degrades to a
 *      raw column instead of silently rendering as `string`.
 *
 * `FieldSchema` is the union of the nine metas: "every supported combination", one
 * declared value you can `Value.Check` against, instead of nine hand-written `match`
 * predicates plus an order contract.
 *
 * Refinement keywords are whitelisted per kind (`string` allows `minLength`/
 * `maxLength`/`pattern`; the numeric kinds allow `minimum`/`maximum`; the list kinds
 * allow `minItems`/`maxItems`/`uniqueItems`), so the "free validation" win survives:
 * a rating is `{type:'integer', minimum:1, maximum:5}`, still kind `integer`, still
 * the numeric widget, validated for free, with no new kind. The shared `ANNOT` keys
 * (`title`, `description`) are allowed on every kind.
 *
 * There is NO `nullable` / optional axis and NO `json` kind. Optionality is deleted
 * (every modeled field is required; "must have content" is a value constraint like
 * `minLength`, not a model flag), so a nullable `anyOf`-with-null shape matches no
 * meta and is unsupported. `json` is the rejection lane, not a member of `Kind`: a
 * shape outside the palette is simply not a field schema.
 */

import { Type } from 'typebox';
import { Value } from 'typebox/value';

/** Reject any property the meta does not explicitly name. The source of mutual exclusivity. */
const CLOSED = { additionalProperties: false } as const;

/**
 * Optional human annotations every field schema may carry. Whitelisted into each
 * closed meta so a `title` override or a `description` does not open the shape.
 */
const ANNOT = {
	title: Type.Optional(Type.String()),
	description: Type.Optional(Type.String()),
};

/** The value space a closed set (`select` / `multiSelect`) may hold. `Number` covers integers. */
const JsonPrimitive = Type.Union([Type.String(), Type.Number(), Type.Boolean()]);

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

/**
 * The single source of the palette: each row pairs a kind name with its closed
 * meta-schema (recognition + boundary validation) and its SQLite storage class.
 * `Kind`, `FieldSchema`, `deriveKind`, and `storageOf` all derive from this array,
 * so adding a kind is one row. Order is NOT a contract: the metas are mutually
 * exclusive, so `deriveKind` returns the same answer regardless of iteration order.
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
			{
				type: Type.Literal('integer'),
				minimum: Type.Optional(Type.Number()),
				maximum: Type.Optional(Type.Number()),
				...ANNOT,
			},
			CLOSED,
		),
	},
	{
		kind: 'number',
		storage: 'REAL',
		meta: Type.Object(
			{
				type: Type.Literal('number'),
				minimum: Type.Optional(Type.Number()),
				maximum: Type.Optional(Type.Number()),
				...ANNOT,
			},
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
			{
				type: Type.Literal('string'),
				minLength: Type.Optional(Type.Integer()),
				maxLength: Type.Optional(Type.Integer()),
				pattern: Type.Optional(Type.String()),
				...ANNOT,
			},
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
				minItems: Type.Optional(Type.Integer()),
				maxItems: Type.Optional(Type.Integer()),
				uniqueItems: Type.Optional(Type.Boolean()),
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
				minItems: Type.Optional(Type.Integer()),
				maxItems: Type.Optional(Type.Integer()),
				uniqueItems: Type.Optional(Type.Boolean()),
				...ANNOT,
			},
			CLOSED,
		),
	},
] as const;

/** The closed set of field kinds, DERIVED from the palette. `json` is not a member. */
export type Kind = (typeof PALETTE)[number]['kind'];

/** The SQLite storage classes a kind can map to. */
export type Storage = (typeof PALETTE)[number]['storage'];

/**
 * The schema-of-schemas: a legal field schema is exactly a member of this union.
 * `validateModel` checks each `matter.json` field against it at the boundary; a
 * field that fails is unsupported and degrades to a raw column.
 */
export const FieldSchema = Type.Union(PALETTE.map((entry) => entry.meta));

/** Boundary guard: is `schema` a legal member of the closed palette? */
export function isFieldSchema(schema: unknown): boolean {
	return Value.Check(FieldSchema, schema);
}

/**
 * Total over a validated schema: the kind whose meta matches. Because the metas are
 * mutually exclusive, exactly one matches any `isFieldSchema` value, so there is no
 * priority order and no `json` fallback. Throws only on a contract violation (called
 * on a schema that did not pass `isFieldSchema`); gate with `isFieldSchema` first.
 */
export function deriveKind(schema: unknown): Kind {
	const entry = PALETTE.find((p) => Value.Check(p.meta, schema));
	if (!entry) {
		throw new Error(
			'deriveKind called on a non-palette schema; gate with isFieldSchema first',
		);
	}
	return entry.kind;
}

/** The SQLite storage class for a kind. Total: `kind` is one of the palette kinds. */
export function storageOf(kind: Kind): Storage {
	const entry = PALETTE.find((p) => p.kind === kind);
	if (!entry) throw new Error(`storageOf called with a non-palette kind: ${kind}`);
	return entry.storage;
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
