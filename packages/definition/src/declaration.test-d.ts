/**
 * Compile-time type tests for declarations. Compiled by `tsc --noEmit`
 * alongside the rest of the package; nothing runs at test time.
 *
 * What these prove: a field map takes any native TypeBox schema, annotated or
 * not, and the row and KV lenses read each one's exact `Static<>`. Helpers and
 * raw schemas sit side by side. The reserved-name rule holds for both, a
 * primitive is not a schema, and a native `default` annotation is admitted.
 * `prepareData` returns the type it was given.
 *
 * See `./field/field.test-d.ts` for the helpers' own types.
 */

import { type Static, Type } from 'typebox';
import type { Brand } from 'wellcrafted/brand';
import {
	type CreateRowOf,
	type DataDefinition,
	defineTable,
	type FieldMap,
	field,
	type InstantString,
	type JsonValue,
	jsonValue,
	type KvOf,
	prepareData,
	type RowOf,
} from './index.js';

type Equal<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
		? true
		: { expected: Y; got: X };
type Expect<T extends true> = T;

type NoteId = string & Brand<'NoteId'>;

const Node = Type.Cyclic(
	{
		Node: Type.Object({
			value: Type.Number(),
			next: Type.Union([Type.Ref('Node'), Type.Null()]),
		}),
	},
	'Node',
);

const mixed = defineTable({
	fields: {
		// Raw native schemas, with no hint.
		meta: Type.Object({
			author: Type.String(),
			words: Type.Optional(Type.Integer()),
		}),
		size: Type.Enum(['small', 'large']),
		anything: Type.Any(),
		open: jsonValue,
		short: Type.Refine(Type.String(), (value) => value.length < 3),
		pair: Type.Tuple([Type.String(), Type.Number()]),
		maybe: Type.Union([Type.Number(), Type.Null()]),
		chain: Node,
		// Helpers, and native composition over them.
		title: field.string(),
		due: field.nullable(field.instant()),
		owner: Type.Refine(field.string<NoteId>(), (value) => value !== ''),
		status: field.nullable(Type.Enum(['draft', 'published'])),
	},
});

type Row = RowOf<typeof mixed>;

export type _RowKeys = Expect<
	Equal<
		keyof Row,
		| 'id'
		| 'meta'
		| 'size'
		| 'anything'
		| 'open'
		| 'short'
		| 'pair'
		| 'maybe'
		| 'chain'
		| 'title'
		| 'due'
		| 'owner'
		| 'status'
	>
>;
export type _RawObject = Expect<
	Equal<Row['meta'], { words?: number; author: string }>
>;
export type _RawEnum = Expect<Equal<Row['size'], 'small' | 'large'>>;
// biome-ignore lint/suspicious/noExplicitAny: the type under test is `any`
export type _RawAny = Expect<Equal<Row['anything'], any>>;
export type _RawJsonValue = Expect<Equal<Row['open'], JsonValue>>;
export type _RawRefine = Expect<Equal<Row['short'], string>>;
export type _RawTuple = Expect<Equal<Row['pair'], [string, number]>>;
export type _RawUnion = Expect<Equal<Row['maybe'], number | null>>;
export type _RawCyclic = Expect<Equal<Row['chain'], Static<typeof Node>>>;
export type _Helper = Expect<Equal<Row['title'], string>>;
export type _NullableHelper = Expect<Equal<Row['due'], InstantString | null>>;
export type _RefinedHelper = Expect<Equal<Row['owner'], NoteId>>;
export type _NullableRaw = Expect<
	Equal<Row['status'], 'draft' | 'published' | null>
>;
export type _CreateHasNoId = Expect<
	Equal<keyof CreateRowOf<typeof mixed>, Exclude<keyof Row, 'id'>>
>;

// KV takes the same schemas.
const definition = {
	id: 'so.epicenter.raw',
	kv: {
		theme: Type.Enum(['light', 'dark']),
		window: Type.Object({ width: Type.Integer(), height: Type.Integer() }),
		name: field.string(),
	},
	tables: { mixed },
} satisfies DataDefinition;
export type _KvRaw = Expect<
	Equal<
		KvOf<typeof definition>,
		{
			theme: 'light' | 'dark';
			window: { width: number; height: number };
			name: string;
		}
	>
>;

// Every schema above is a field, with or without a hint.
export const _fields: FieldMap = { ...mixed.fields, ...definition.kv };

// The rules that are about a declaration, not an editor, hold for raw schemas.
defineTable({
	fields: {
		// @ts-expect-error 'id' is reserved: every row already has one
		id: Type.String(),
	},
});

// A schema is an object. TypeBox's `TSchema` is an empty interface, so a
// primitive would satisfy it; a field map and the schema-taking helpers do not
// take one.
defineTable({
	fields: {
		// @ts-expect-error a string is not a schema
		title: 'string',
		// @ts-expect-error a number is not a schema
		count: 7,
		// @ts-expect-error a boolean is not a schema
		done: true,
	},
});
export const _primitiveKv = {
	id: 'so.epicenter.primitive',
	// @ts-expect-error a string is not a schema
	kv: { theme: 'string' },
	tables: {},
} satisfies DataDefinition;
// @ts-expect-error a string is not a schema
export const _primitiveField: FieldMap = { title: 'string' };
// @ts-expect-error a string is not a schema
field.nullable('string');
// @ts-expect-error a number is not a schema
field.json(7);

// Schema objects of every native spelling are still taken, and a native
// `default` annotation is one of them.
const admitted = defineTable({
	fields: {
		literal: { type: 'string' },
		empty: {},
		withDefault: Type.String({ default: 'untitled' }),
		spreadDefault: { ...field.string(), default: 'untitled' },
		frozen: Object.freeze(field.select(['a', 'b'])),
		wrapped: field.json({ type: 'string' }),
		optional: field.nullable({ type: 'string' }),
	},
});
type Admitted = RowOf<typeof admitted>;
export type _DefaultStatic = Expect<Equal<Admitted['withDefault'], string>>;
export type _SpreadDefaultStatic = Expect<
	Equal<Admitted['spreadDefault'], string>
>;
export type _FrozenStatic = Expect<Equal<Admitted['frozen'], 'a' | 'b'>>;
// A default annotation does not make a field optional.
// @ts-expect-error withDefault is still required
export const _stillRequired: Pick<
	CreateRowOf<typeof admitted>,
	'withDefault'
> = {};

// A prepared definition has the declared type: the same literal keys and the
// same native schemas, so the lenses read it like the declaration.
const prepared = prepareData(definition).data;
if (prepared !== null) {
	prepared satisfies typeof definition;
	// A prepared native snapshot can be composed again without a cast.
	field.json(prepared.kv.theme);
	field.nullable(prepared.tables.mixed.fields.title);
	// @ts-expect-error the prepared definition declares no such table
	prepared.tables.absent;
	// @ts-expect-error a prepared table has fields and a body, and no name
	prepared.tables.mixed.name;
}
export type _PreparedKv = Expect<
	Equal<
		KvOf<NonNullable<typeof prepared>>,
		{
			theme: 'light' | 'dark';
			window: { width: number; height: number };
			name: string;
		}
	>
>;
export type _PreparedRow = Expect<
	Equal<RowOf<NonNullable<typeof prepared>['tables']['mixed']>, Row>
>;
