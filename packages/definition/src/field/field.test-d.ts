/**
 * Compile-time type tests for the `field.*` builders. Compiled by `tsc --noEmit`
 * alongside the rest of the package; nothing runs at test time.
 *
 * Pattern: each assertion is exported so `noUnusedLocals` does not flag it. If an
 * assertion fails, the type error appears at the offending line during typecheck.
 *
 * What these prove: a helper's return is a native schema whose `Static<>` is the
 * authored type, brands and literal unions included; its hint is typed as
 * what the helper was told; `nullable` and `json` take any native schema; and
 * `optional` keeps its inner `Static<>` and is marked optional.
 *
 * See `../declaration.test-d.ts` for raw native schemas in a declaration.
 */

import { type Static, Type } from 'typebox';
import type { Brand } from 'wellcrafted/brand';
import type { JsonValue } from 'wellcrafted/json';
import { field, type jsonValue } from './builders.js';
import type { CalendarDateString } from './calendar-date-string.js';
import type { DateTimeString } from './datetime-string.js';
import type { Annotated, FieldHint } from './editor.js';
import type { InstantString } from './instant-string.js';

/**
 * A failed assertion carries both sides, so the error names what moved.
 *
 * `Expect` requires `true`, so an unequal pair reports the object below rather
 * than `Type 'false' does not satisfy the constraint 'true'`, which names
 * neither type:
 *
 *     Type '{ expected: "draft" | "published"; got: string; }'
 *     does not satisfy the constraint 'true'.
 *
 * Copied rather than shared. It is four lines of the canonical spelling with no
 * semantics of its own, and the three copies live in `packages/app/src/data/field`,
 * `packages/app/src/data/definition`, and `apps/whispering`, which do not
 * otherwise reach into each other for test
 * utilities. `wellcrafted/testing` exports this pair as of the release after
 * 0.44.0; import it from there once the catalog moves and these go.
 */
type Equal<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
		? true
		: { expected: Y; got: X };
type Expect<T extends true> = T;

type NoteId = string & Brand<'NoteId'>;

// field.string(): Static = string
export type _StringStatic = Expect<
	Equal<Static<ReturnType<typeof field.string>>, string>
>;

// field.string<NoteId>(): Static = NoteId (brand preserved)
export type _StringBrandStatic = Expect<
	Equal<Static<ReturnType<typeof field.string<NoteId>>>, NoteId>
>;

// field.string<'draft'>(): never (literal subtypes rejected; use field.select)
export type _StringLiteralRejected = Expect<
	Equal<ReturnType<typeof field.string<'draft'>>, never>
>;

// field.reference('table'): Static = string
export type _ReferenceStatic = Expect<
	Equal<Static<ReturnType<typeof field.reference>>, string>
>;

// field.reference<NoteId>('table'): Static = NoteId (brand preserved)
export type _ReferenceBrandStatic = Expect<
	Equal<Static<ReturnType<typeof field.reference<NoteId>>>, NoteId>
>;

// field.reference<'draft'>('table'): never (literal subtypes rejected, like field.string)
export type _ReferenceLiteralRejected = Expect<
	Equal<ReturnType<typeof field.reference<'draft'>>, never>
>;

// field.url(): Static = string
export type _UrlStatic = Expect<
	Equal<Static<ReturnType<typeof field.url>>, string>
>;

// field.date(): Static = CalendarDateString (brand preserved)
export type _DateStatic = Expect<
	Equal<Static<ReturnType<typeof field.date>>, CalendarDateString>
>;

// field.instant(): Static = InstantString (brand preserved)
export type _InstantStatic = Expect<
	Equal<Static<ReturnType<typeof field.instant>>, InstantString>
>;

// field.datetime(): Static = DateTimeString (brand preserved)
export type _DatetimeStatic = Expect<
	Equal<Static<ReturnType<typeof field.datetime>>, DateTimeString>
>;

// field.select([...]): Static = literal union of members  (OQ2)
const statusIds = ['draft', 'published'] as Array<'draft' | 'published'>;
export type _SelectStatic = Expect<
	Equal<
		Static<ReturnType<typeof field.select<typeof statusIds>>>,
		'draft' | 'published'
	>
>;

// field.select is string-only: a numeric member list is a compile error.
// @ts-expect-error select holds strings; a numeric range is integer + min/max
export type _SelectStringsOnly = typeof field.select<[1, 2, 3]>;

// field.multiSelect([...]): Static = array of the literal union
export type _MultiSelectStatic = Expect<
	Equal<
		Static<ReturnType<typeof field.multiSelect<typeof statusIds>>>,
		('draft' | 'published')[]
	>
>;

// field.tags(): Static = string[]
export type _TagsStatic = Expect<
	Equal<Static<ReturnType<typeof field.tags>>, string[]>
>;

// field.number / field.integer: Static = number; field.boolean: Static = boolean
export type _NumberStatic = Expect<
	Equal<Static<ReturnType<typeof field.number>>, number>
>;
export type _IntegerStatic = Expect<
	Equal<Static<ReturnType<typeof field.integer>>, number>
>;
export type _BooleanStatic = Expect<
	Equal<Static<ReturnType<typeof field.boolean>>, boolean>
>;

// field.json(inner): Static = Static<inner>. The authoring type tracks the payload schema.
export type _JsonTypedStatic = Expect<
	Equal<
		Static<
			ReturnType<
				typeof field.json<
					ReturnType<
						typeof Type.Object<{ author: ReturnType<typeof Type.String> }>
					>
				>
			>
		>,
		{ author: string }
	>
>;

// jsonValue: the canonical any-JSON inner, Static = JsonValue (pinned via Type.Unsafe).
export type _JsonValueStatic = Expect<
	Equal<Static<typeof jsonValue>, JsonValue>
>;

// field.json(Type.Array(jsonValue)): Static = JsonValue[]. The list-of-arbitrary-JSON
// pattern the apps share; the inner static flows through Array and field.json unchanged.
export type _JsonArrayStatic = Expect<
	Equal<
		Static<
			ReturnType<
				typeof field.json<ReturnType<typeof Type.Array<typeof jsonValue>>>
			>
		>,
		JsonValue[]
	>
>;

// field.json(field.select([...])): the select's literal union flows through.
const sizes = field.json(field.select(['small', 'large']));
export type _JsonOfFieldStatic = Expect<
	Equal<Static<typeof sizes>, 'small' | 'large'>
>;

// Options do not disturb the brand, alone or under nullable.
const boundedId = field.string<NoteId>({ maxLength: 64 });
export type _BoundedBrandStatic = Expect<
	Equal<Static<typeof boundedId>, NoteId>
>;
const boundedRef = field.nullable(
	field.reference<NoteId>('notes', { maxLength: 64 }),
);
export type _BoundedNullableRefStatic = Expect<
	Equal<Static<typeof boundedRef>, NoteId | null>
>;
// @ts-expect-error a byte ceiling is not a schema keyword
field.string({ maxBytes: 64 });

// field.nullable(inner): Static = Static<inner> | null, for brands, literal
// unions, and JSON payloads alike.
const nullableStatus = field.nullable(field.select(['draft', 'published']));
export type _NullableSelectStatic = Expect<
	Equal<Static<typeof nullableStatus>, 'draft' | 'published' | null>
>;
const nullablePayload = field.nullable(
	field.json(Type.Object({ author: Type.String() })),
);
export type _NullableJsonStatic = Expect<
	Equal<Static<typeof nullablePayload>, { author: string } | null>
>;
const nullableInstant = field.nullable(field.instant());
export type _NullableInstantStatic = Expect<
	Equal<Static<typeof nullableInstant>, InstantString | null>
>;

// The hint keeps what the helper was told, literally: the kind, and a
// reference's target. It holds nothing the schema already says.
const status = field.select(['draft', 'published']);
export type _SelectHint = Expect<
	Equal<(typeof status)['x-field'], { readonly kind: 'select' }>
>;
export type _PlainHint = Expect<
	Equal<
		ReturnType<typeof field.integer>['x-field'],
		{ readonly kind: 'integer' }
	>
>;
const page = field.reference('pages');
export type _ReferenceKind = Expect<
	Equal<(typeof page)['x-field']['kind'], 'reference'>
>;
export type _ReferenceTarget = Expect<
	Equal<(typeof page)['x-field']['target'], 'pages'>
>;
export const _hint: FieldHint = page['x-field'];

// A select's options are the native schema's enum, typed as the tuple.
export type _SelectOptions = Expect<
	Equal<(typeof status)['enum'], ['draft', 'published']>
>;
const labels = field.multiSelect(['a', 'b']);
export type _MultiSelectOptions = Expect<
	Equal<(typeof labels)['items']['enum'], ['a', 'b']>
>;

// field.nullable is the native union: no hint of its own, and the inner
// schema, hint included, is its first member.
export type _NullableIsNativeUnion = Expect<
	Equal<
		typeof nullableStatus,
		ReturnType<typeof Type.Union<[typeof status, ReturnType<typeof Type.Null>]>>
	>
>;
export type _NullableMemberHint = Expect<
	Equal<(typeof nullableStatus)['anyOf'][0]['x-field']['kind'], 'select'>
>;
// @ts-expect-error the union carries no hint of its own
nullableStatus['x-field'];

// field.nullable and field.json take any native schema, and Static follows.
const nullablePlain = field.nullable(Type.Object({ a: Type.Number() }));
export type _NullablePlainStatic = Expect<
	Equal<Static<typeof nullablePlain>, { a: number } | null>
>;
const nullableBranded = field.nullable(field.string<NoteId>());
export type _NullableBrandedStatic = Expect<
	Equal<Static<typeof nullableBranded>, NoteId | null>
>;

// field.optional keeps the inner Static and is a native optional, outside
// nullable as well.
const optionalNote = field.optional(field.nullable(field.string<NoteId>()));
export type _OptionalStatic = Expect<
	Equal<Static<typeof optionalNote>, NoteId | null>
>;
export type _OptionalMarked = Expect<
	Equal<(typeof optionalNote)['~optional'], true>
>;
// @ts-expect-error a primitive is not a schema
field.optional('string');
export type _JsonHint = Expect<
	Equal<(typeof sizes)['x-field'], { readonly kind: 'json' }>
>;

// A helper's return and a hand-annotated native schema are the same type.
export const _handAnnotated: Annotated = Type.String({
	'x-field': { kind: 'string' },
}) as Annotated<ReturnType<typeof Type.String>, { kind: 'string' }>;

// @ts-expect-error: byte ownership is not a field constructor.
export type _NoBlobBuilder = typeof field.blob;
// @ts-expect-error: byte ownership is not a field constructor.
export type _NoAttachmentBuilder = typeof field.attachment;
