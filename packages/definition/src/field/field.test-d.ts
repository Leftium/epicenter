/**
 * Compile-time type tests for the `field.*` builders. Compiled by `tsc --noEmit`
 * alongside the rest of the package; nothing runs at test time.
 *
 * Pattern: each assertion is exported so `noUnusedLocals` does not flag it. If an
 * assertion fails, the type error appears at the offending line during typecheck.
 *
 * What these prove: a helper's return is a native schema whose `Static<>` is the
 * authored type, brands and literal unions included, and a declaration takes
 * helper-built fields only.
 */

import { type Static, Type } from 'typebox';
import type { Brand } from 'wellcrafted/brand';
import type { JsonValue } from 'wellcrafted/json';
import { field, type jsonValue } from './builders.js';
import type { CalendarDateString } from './calendar-date-string.js';
import type { DateTimeString } from './datetime-string.js';
import type { InstantString } from './instant-string.js';
import type { FieldMetadata, FieldSchema } from './metadata.js';

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

// A byte ceiling is a runtime refinement; it does not disturb the brand.
const boundedId = field.string<NoteId>({ maxBytes: 64 });
export type _BoundedBrandStatic = Expect<
	Equal<Static<typeof boundedId>, NoteId>
>;
const boundedRef = field.nullable(
	field.reference<NoteId>('notes', { maxBytes: 64 }),
);
export type _BoundedNullableRefStatic = Expect<
	Equal<Static<typeof boundedRef>, NoteId | null>
>;

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

// Every helper's return is a field, and its annotation is typed.
const everyField: FieldSchema[] = [
	field.string(),
	boundedId,
	boundedRef,
	field.url(),
	field.number(),
	field.integer(),
	field.boolean(),
	field.date(),
	field.instant(),
	field.datetime(),
	nullableStatus,
	field.multiSelect(['a']),
	field.tags(),
	sizes,
	nullablePayload,
	// A native refinement over a field is still that field.
	Type.Refine(field.string(), (value) => value !== ''),
];
export const _annotation: FieldMetadata = nullableStatus['x-field'];
void everyField;

// The annotation keeps what the helper was told, literally: a widget reads
// the option tuple, the kind, and nullability without narrowing.
const status = field.select(['draft', 'published']);
export type _SelectMetadata = Expect<
	Equal<
		(typeof status)['x-field'],
		{ readonly kind: 'select'; readonly nullable: false } & {
			readonly options: readonly ['draft', 'published'];
		}
	>
>;
export type _SelectOptions = Expect<
	Equal<(typeof status)['x-field']['options'][number], 'draft' | 'published'>
>;
export type _NullableSelectKind = Expect<
	Equal<(typeof nullableStatus)['x-field']['kind'], 'select'>
>;
export type _NullableSelectNullable = Expect<
	Equal<(typeof nullableStatus)['x-field']['nullable'], true>
>;
export type _NullableSelectOptions = Expect<
	Equal<
		(typeof nullableStatus)['x-field']['options'],
		readonly ['draft', 'published']
	>
>;
const labels = field.multiSelect(['a', 'b']);
export type _MultiSelectOptions = Expect<
	Equal<(typeof labels)['x-field']['options'], readonly ['a', 'b']>
>;
const page = field.nullable(field.reference('pages'));
export type _ReferenceTarget = Expect<
	Equal<(typeof page)['x-field']['target'], 'pages'>
>;
export type _ReferenceNullable = Expect<
	Equal<(typeof page)['x-field']['nullable'], true>
>;
export type _PlainKind = Expect<
	Equal<
		ReturnType<typeof field.integer>['x-field'],
		{ readonly kind: 'integer'; readonly nullable: false }
	>
>;
export type _JsonKind = Expect<
	Equal<(typeof nullablePayload)['x-field']['kind'], 'json'>
>;
// A literal reads without a cast where a widget wants one.
export const _firstOption: 'draft' = status['x-field'].options[0];
export const _isNullable: true = nullableStatus['x-field'].nullable;

// A bare native schema is not a field, at the top level or under nullable.
// @ts-expect-error a field is built with field.*
export const _bareString: FieldSchema = Type.String();
// @ts-expect-error a hand-written annotation is not provenance
export const _forged: FieldSchema = Type.String({
	'x-field': { kind: 'string', nullable: false },
});
// @ts-expect-error nullable wraps a field
field.nullable(Type.String());

// @ts-expect-error: byte ownership is not a field constructor.
export type _NoBlobBuilder = typeof field.blob;
// @ts-expect-error: byte ownership is not a field constructor.
export type _NoAttachmentBuilder = typeof field.attachment;
