/**
 * Field Helper Tests
 *
 * A `field.*` helper returns one native TypeBox schema annotated with the
 * editor it gets. These tests check the schema with TypeBox's own `Compile`,
 * never through this package's compiler, so they hold the helpers to being
 * native on their own.
 *
 * Key behaviors:
 * - Every helper annotates its schema with its kind, and the annotation is an
 *   ordinary enumerable keyword
 * - A select's options and a reference's target are in the annotation, and
 *   `field.nullable` keeps them
 * - `maxBytes` is a native refinement
 * - `field.json` keeps every hidden keyword of the schema it wraps, and decides
 *   that a value is JSON before the wrapped schema sees it
 * - A helper copies its arguments and leaves them as they were; what it
 *   returns is an ordinary mutable native schema with a frozen annotation
 *
 * See also:
 * - `field.test-d.ts` for `Static<>` and the helper-only declaration types
 * - `../compile.test.ts` for the compiler that prepares these schemas
 */

import { describe, expect, test } from 'bun:test';
import { type TSchema, Type } from 'typebox';
import { Compile } from 'typebox/compile';
import { Value } from 'typebox/value';
import { isJsonObject, isJsonSafe, isJsonValue } from '../json.js';
import { field, jsonValue } from './builders.js';
import {
	FIELD_KEYWORD,
	type FieldMetadata,
	fieldMetadataOf,
	type Kind,
} from './metadata.js';

const check = (schema: TSchema, value: unknown) => Compile(schema).Check(value);

const BUILT: Record<Kind, TSchema> = {
	string: field.string(),
	reference: field.reference('pages'),
	url: field.url(),
	date: field.date(),
	instant: field.instant(),
	datetime: field.datetime(),
	select: field.select(['draft', 'published']),
	integer: field.integer(),
	number: field.number(),
	boolean: field.boolean(),
	tags: field.tags(),
	multiSelect: field.multiSelect(['a', 'b']),
	json: field.json(jsonValue),
};

describe('every helper annotates a native schema', () => {
	for (const [kind, schema] of Object.entries(BUILT)) {
		test(`field.${kind} is kind ${kind}, not nullable, and enumerable`, () => {
			expect(fieldMetadataOf(schema)).toMatchObject({ kind, nullable: false });
			expect(Object.keys(schema)).toContain(FIELD_KEYWORD);
			expect(JSON.parse(JSON.stringify(schema))[FIELD_KEYWORD].kind).toBe(kind);
		});
	}

	test('number and integer are distinct kinds with distinct checks', () => {
		expect(fieldMetadataOf(field.number())?.kind).toBe('number');
		expect(fieldMetadataOf(field.integer())?.kind).toBe('integer');
		expect(check(field.number(), 1.5)).toBe(true);
		expect(check(field.integer(), 1.5)).toBe(false);
		expect(check(field.number(), Number.NaN)).toBe(false);
		expect(check(field.integer({ minimum: 1, maximum: 5 }), 6)).toBe(false);
	});

	test('a bare native schema is not a field', () => {
		expect(fieldMetadataOf(Type.String())).toBeNull();
		expect(fieldMetadataOf({ type: 'string', [FIELD_KEYWORD]: {} })).toBeNull();
		expect(
			fieldMetadataOf({ [FIELD_KEYWORD]: { kind: 'blob', nullable: false } }),
		).toBeNull();
	});

	test('temporal helpers keep their formats', () => {
		expect(check(field.date(), '2026-06-09')).toBe(true);
		expect(check(field.date(), '2026-02-30')).toBe(false);
		expect(check(field.instant(), '2026-06-09T14:00:00.000Z')).toBe(true);
		expect(check(field.instant(), '2026-06-09T14:00:00Z')).toBe(false);
		expect(check(field.instant(), '2026-06-09T14:00:00.000-05:00')).toBe(false);
		expect(check(field.datetime(), '2026-06-09T14:00:00-05:00')).toBe(true);
		expect(check(field.url(), 'not a url')).toBe(false);
	});
});

describe('options are the supported ones', () => {
	test('an option cannot replace what the helper sets', () => {
		for (const declare of [
			// @ts-expect-error the format is the helper's
			() => field.url({ format: 'email' }),
			// @ts-expect-error the type is the helper's
			() => field.string({ type: 'number' }),
			// @ts-expect-error the annotation is the helper's
			() => field.string({ [FIELD_KEYWORD]: { kind: 'url', nullable: false } }),
			// @ts-expect-error a default belongs to the application
			() => field.string({ default: 'untitled' }),
			// @ts-expect-error a typo is not an option
			() => field.tags({ minItem: 1 }),
			// @ts-expect-error instant owns its pattern
			() => field.instant({ pattern: '.*' }),
		])
			expect(declare).toThrow('does not support');
	});

	test('supported options reach the native schema', () => {
		const title = field.string({ minLength: 2, pattern: '^[a-z]+$' });
		expect(check(title, 'ab')).toBe(true);
		expect(check(title, 'a')).toBe(false);
		expect(check(title, 'AB')).toBe(false);
		const labels = field.tags({ maxItems: 1, uniqueItems: true });
		expect(check(labels, ['a'])).toBe(true);
		expect(check(labels, ['a', 'b'])).toBe(false);
		expect(field.url({ title: 'Homepage' })).toMatchObject({
			title: 'Homepage',
			format: 'uri',
		});
	});

	test('an options object changed after the call changes nothing', () => {
		const opts = { minLength: 2 };
		const title = field.string(opts);
		opts.minLength = 0;
		expect(check(title, 'a')).toBe(false);
	});
});

describe('string byte ceilings', () => {
	test('maxBytes counts UTF-8 bytes at the exact boundary', () => {
		const schema = field.string({ maxBytes: 4 });
		expect(check(schema, 'abcd')).toBe(true);
		expect(check(schema, 'abcde')).toBe(false);
		expect(check(schema, '😀')).toBe(true);
		expect(check(schema, '😀a')).toBe(false);
		expect(check(schema, 4)).toBe(false);
		expect(
			Compile(schema)
				.Errors('abcde')
				.map((error) => error.message),
		).toEqual(['must be at most 4 UTF-8 bytes']);
	});

	test('maxBytes composes with the other string options and with null', () => {
		const schema = field.nullable(field.string({ maxBytes: 4, minLength: 2 }));
		expect(check(schema, 'ab')).toBe(true);
		expect(check(schema, 'a')).toBe(false);
		expect(check(schema, 'abcde')).toBe(false);
		expect(check(schema, null)).toBe(true);
	});

	test('maxBytes is not a keyword, and a bad ceiling is refused', () => {
		expect(Object.keys(field.string({ maxBytes: 4 }))).not.toContain(
			'maxBytes',
		);
		expect(() => field.string({ maxBytes: -1 })).toThrow('maxBytes');
		expect(() => field.string({ maxBytes: 1.5 })).toThrow('maxBytes');
	});
});

describe('reference', () => {
	test('the target is in the annotation and the value is never empty', () => {
		const schema = field.reference('pages');
		expect(fieldMetadataOf(schema)).toEqual({
			kind: 'reference',
			nullable: false,
			target: 'pages',
		});
		expect(check(schema, 'become-the-source')).toBe(true);
		expect(check(schema, '')).toBe(false);
		expect(check(schema, 42)).toBe(false);
	});

	test('a larger minLength is kept and a smaller one is raised to 1', () => {
		expect(check(field.reference('pages', { minLength: 5 }), 'abcd')).toBe(
			false,
		);
		expect(check(field.reference('pages', { minLength: 0 }), '')).toBe(false);
	});

	test('a reference needs a table name', () => {
		expect(() => field.reference('')).toThrow('name of a table');
	});
});

describe('select and multiSelect own their option list', () => {
	test('the annotation and the schema are built from one list', () => {
		const status = field.select(['draft', 'published']);
		expect(status[FIELD_KEYWORD].options).toEqual(['draft', 'published']);
		expect(status.enum).toEqual(['draft', 'published']);
		expect(Object.isFrozen(status[FIELD_KEYWORD])).toBe(true);
		expect(Object.isFrozen(status[FIELD_KEYWORD].options)).toBe(true);

		const labels = field.multiSelect(['a', 'b'], { uniqueItems: true });
		expect(labels[FIELD_KEYWORD].options).toEqual(labels.items.enum);
		expect(check(labels, ['a', 'b'])).toBe(true);
		expect(check(labels, ['a', 'a'])).toBe(false);
		expect(check(labels, ['c'])).toBe(false);
	});

	test('changing the list that was passed in changes neither validator nor widget', () => {
		const values = ['draft', 'published'];
		const status = field.select(values);
		const labels = field.multiSelect(values);
		values.push('archived');
		values[0] = 'renamed';
		for (const schema of [status, labels]) {
			expect(fieldMetadataOf(schema)).toMatchObject({
				options: ['draft', 'published'],
			});
		}
		expect(check(status, 'draft')).toBe(true);
		expect(check(status, 'archived')).toBe(false);
		expect(check(labels, ['archived'])).toBe(false);
	});

	test('a field is an ordinary schema; only its annotation is frozen', () => {
		const status = field.select(['draft', 'published']);
		expect(Object.isFrozen(status)).toBe(false);
		expect(Object.isFrozen(status.enum)).toBe(false);
		expect(() => {
			(status[FIELD_KEYWORD] as { kind: string }).kind = 'string';
		}).toThrow();
		expect(() =>
			(status[FIELD_KEYWORD].options as readonly string[] as string[]).push(
				'archived',
			),
		).toThrow();
	});

	test('an empty or non-string list is refused', () => {
		expect(() => field.select([])).toThrow('at least one string option');
		// @ts-expect-error select holds strings; a numeric range is integer + min/max
		expect(() => field.select([1, 2])).toThrow('at least one string option');
		expect(() => field.multiSelect([])).toThrow('at least one string option');
	});
});

describe('nullable', () => {
	test('it is the native union with null and keeps the editor', () => {
		const status = field.nullable(field.select(['draft', 'published']));
		expect(fieldMetadataOf(status)).toEqual({
			kind: 'select',
			nullable: true,
			options: ['draft', 'published'],
		});
		expect(check(status, null)).toBe(true);
		expect(check(status, 'draft')).toBe(true);
		expect(check(status, 'archived')).toBe(false);
		expect(check(status, undefined)).toBe(false);

		const page = field.nullable(field.reference('pages'));
		expect(fieldMetadataOf(page)).toEqual({
			kind: 'reference',
			nullable: true,
			target: 'pages',
		});
		expect(check(page, null)).toBe(true);
		expect(check(page, '')).toBe(false);
	});

	test('the field it wraps is not changed, and never frozen', () => {
		const status = field.select(['draft']);
		field.nullable(status);
		expect(fieldMetadataOf(status)?.nullable).toBe(false);
		expect(check(status, null)).toBe(false);

		// A native refinement over a field is the caller's own schema.
		const refined = Type.Refine(field.string(), (value) => value !== '');
		const wrapped = field.nullable(refined);
		expect(Object.isFrozen(refined)).toBe(false);
		Object.assign(refined, { maxLength: 1 });
		expect(refined).toMatchObject({ maxLength: 1 });
		expect(
			check(
				Type.Refine(refined, () => true),
				'ab',
			),
		).toBe(false);
		// The nullable field was built from what `refined` was at the call.
		expect(check(wrapped, 'ab')).toBe(true);
		expect(check(wrapped, '')).toBe(false);
	});

	test('it wraps a field, not a bare schema', () => {
		// @ts-expect-error a bare schema has no editor to keep
		expect(() => field.nullable(Type.String())).toThrow('field.*');
	});
});

describe('json wraps the schema it is given', () => {
	const Author = Type.Object(
		{ author: Type.String() },
		{ additionalProperties: false },
	);
	const never = () => false;

	test('an object, an array, and a nested payload are checked as declared', () => {
		expect(fieldMetadataOf(field.json(Author))).toEqual({
			kind: 'json',
			nullable: false,
		});
		expect(check(field.json(Author), { author: 'Braden' })).toBe(true);
		expect(check(field.json(Author), { author: 42 })).toBe(false);
		expect(check(field.json(Author), { author: 'x', extra: 1 })).toBe(false);

		const list = field.json(Type.Array(Author, { maxItems: 1 }));
		expect(check(list, [{ author: 'a' }])).toBe(true);
		expect(check(list, [{ author: 'a' }, { author: 'b' }])).toBe(false);

		const nested = field.nullable(
			field.json(Type.Object({ by: Author, tags: Type.Array(Type.String()) })),
		);
		expect(fieldMetadataOf(nested)).toEqual({ kind: 'json', nullable: true });
		expect(check(nested, { by: { author: 'a' }, tags: ['x'] })).toBe(true);
		expect(check(nested, { by: { author: 1 }, tags: ['x'] })).toBe(false);
		expect(check(nested, null)).toBe(true);
	});

	test('a refinement on the payload schema survives, at the root and nested', () => {
		const refused = Type.Refine(Type.Object({ a: Type.String() }), never);
		// The control: copying only enumerable keywords loses the refinement.
		expect(check(Type.Options(refused, {}), { a: 'x' })).toBe(true);

		expect(check(field.json(refused), { a: 'x' })).toBe(false);
		expect(check(field.json(Type.Array(refused)), [{ a: 'x' }])).toBe(false);
		expect(check(field.nullable(field.json(refused)), { a: 'x' })).toBe(false);
		expect(
			check(field.json(Type.Object({ inner: refused })), { inner: { a: 'x' } }),
		).toBe(false);
		expect(check(field.nullable(field.json(refused)), null)).toBe(true);
	});

	test('a frozen payload schema works and is left as it was', () => {
		const refused = Object.freeze(
			Type.Refine(Type.Object({ a: Type.String() }), never),
		);
		expect(check(field.json(refused), { a: 'x' })).toBe(false);
		const plain = Object.freeze(Type.Object({ a: Type.String() }));
		expect(check(field.json(plain), { a: 'x' })).toBe(true);
		expect(FIELD_KEYWORD in plain).toBe(false);
		expect('~refine' in plain).toBe(false);
	});

	test('a payload schema changed after the call changes nothing', () => {
		const payload = Type.Object({ a: Type.String() });
		const wrapped = field.json(payload);
		Object.assign(payload.properties, { a: Type.Number() });
		expect(check(wrapped, { a: 'x' })).toBe(true);
		expect(check(wrapped, { a: 1 })).toBe(false);
	});

	test('wrapping a field replaces its editor and keeps its check', () => {
		const status = field.select(['small', 'large']);
		const wrapped = field.json(status);
		expect(fieldMetadataOf(wrapped)).toEqual({ kind: 'json', nullable: false });
		expect(fieldMetadataOf(status)).toMatchObject({ kind: 'select' });
		expect(check(wrapped, 'small')).toBe(true);
		expect(check(wrapped, 'medium')).toBe(false);

		const bounded = field.json(field.string({ maxBytes: 2 }));
		expect(check(bounded, 'ab')).toBe(true);
		expect(check(bounded, 'abc')).toBe(false);
	});

	test('a JSON Schema written by hand is checked the same way', () => {
		const text = field.json({
			$defs: { text: { type: 'string', minLength: 2 } },
			$ref: '#/$defs/text',
		});
		expect(check(text, 'yes')).toBe(true);
		expect(check(text, 'x')).toBe(false);
		expect(check(text, 2)).toBe(false);
	});

	test('only JSON is admitted, whatever the payload schema says', () => {
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		class Point {
			x = 1;
		}
		const unsafe = [
			new Date(),
			undefined,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			cycle,
			new Point(),
			new Map(),
			() => 1,
			1n,
			Symbol('s'),
			{ nested: [new Date()] },
			{ nested: undefined },
		];
		// The control: the native schema alone admits a Date.
		expect(check(Type.Any(), new Date())).toBe(true);
		for (const schema of [
			field.json(jsonValue),
			field.json(Type.Any()),
			field.json(Type.Unknown()),
			field.json(Type.Unsafe<Date>({})),
			field.nullable(field.json(jsonValue)),
		]) {
			for (const value of unsafe) expect(check(schema, value)).toBe(false);
			for (const value of [1, 'x', true, { a: [1, null] }, [1, 2]])
				expect(check(schema, value)).toBe(true);
		}
		expect(check(field.json(Type.Array(jsonValue)), [new Date()])).toBe(false);
		expect(check(field.json(Type.Object({})), new Point())).toBe(false);
		expect(check(field.json(jsonValue), null)).toBe(true);
	});

	test('being JSON has no size: wide, deep, and shared values pass', () => {
		const wide = Object.fromEntries(
			Array.from({ length: 1025 }, (_, index) => [`key${index}`, index]),
		);
		let deep: unknown = 'bottom';
		for (let level = 0; level < 100_000; level++) deep = [deep];
		const shared = { leaf: [1, 2] };
		const dag = { left: shared, right: shared, both: [shared, shared] };
		let deepCycle: unknown[] = [];
		const top = deepCycle;
		for (let level = 0; level < 100_000; level++) {
			const next: unknown[] = [];
			deepCycle.push(next);
			deepCycle = next;
		}
		deepCycle.push(top);

		expect(isJsonSafe(wide)).toBe(true);
		expect(isJsonSafe(deep)).toBe(true);
		expect(isJsonSafe(dag)).toBe(true);
		expect(isJsonSafe(top)).toBe(false);
		// The bounded guards keep the storage budget.
		expect(isJsonValue(wide)).toBe(false);
		expect(isJsonObject(wide)).toBe(false);
		expect(isJsonValue([[[[[[[[[[[[[[[[[1]]]]]]]]]]]]]]]]])).toBe(false);

		const open = Compile(field.json(jsonValue));
		expect(open.Check(wide)).toBe(true);
		expect(open.Check(dag)).toBe(true);
		expect(open.Check(deep)).toBe(true);
		expect(open.Check(top)).toBe(false);
		expect(open.Errors(top)).not.toEqual([]);
	});
});

describe('json decides a value is JSON before the payload schema runs', () => {
	const Node = Type.Cyclic(
		{
			Node: Type.Object({
				value: Type.Number(),
				next: Type.Union([Type.Ref('Node'), Type.Null()]),
			}),
		},
		'Node',
	);
	const chain = { value: 1, next: { value: 2, next: null } };
	const loop: Record<string, unknown> = { value: 1 };
	loop.next = loop;

	test('the control: the recursive schema alone overflows on a cyclic value', () => {
		expect(() => Compile(Node).Check(loop)).toThrow(RangeError);
		// A refinement runs after the schema's own keywords, so it is too late.
		const after = Compile(Type.Refine(Node, isJsonSafe));
		expect(() => after.Check(loop)).toThrow(RangeError);
		expect(() => after.Errors(loop)).toThrow(RangeError);
	});

	test('a cyclic value is refused by Check and Errors without running the schema', () => {
		for (const schema of [
			field.json(Node),
			field.nullable(field.json(Node)),
			Type.Refine(field.json(Node), () => true),
		]) {
			const compiled = Compile(schema);
			expect(compiled.Check(loop)).toBe(false);
			expect(compiled.Errors(loop).map((error) => error.message)).toContain(
				'must be a JSON value',
			);
			// TypeBox's interpreter takes the same branch as its compiled code.
			expect(Value.Check(schema, loop)).toBe(false);
			expect(Value.Errors(schema, loop)).not.toEqual([]);

			expect(compiled.Check(chain)).toBe(true);
			expect(compiled.Errors(chain)).toEqual([]);
			expect(Value.Check(schema, chain)).toBe(true);
			const wrong = { value: 1, next: { value: 'two', next: null } };
			expect(compiled.Check(wrong)).toBe(false);
			expect(compiled.Errors(wrong)).not.toEqual([]);
		}
	});

	test('a local reference inside the payload schema still resolves', () => {
		const text = field.json({
			$defs: { text: { type: 'string', minLength: 2 } },
			$ref: '#/$defs/text',
		});
		for (const schema of [text, field.nullable(text)]) {
			expect(check(schema, 'yes')).toBe(true);
			expect(check(schema, 'x')).toBe(false);
			expect(check(schema, 2)).toBe(false);
			expect(Value.Check(schema, 'yes')).toBe(true);
			expect(Value.Check(schema, 'x')).toBe(false);
		}
		const nested = field.json(
			Type.Object({
				count: { $defs: { n: { type: 'number' } }, $ref: '#/$defs/n' },
			}),
		);
		expect(check(nested, { count: 1 })).toBe(true);
		expect(check(nested, { count: 'one' })).toBe(false);
	});
});

describe('a native refinement over a field', () => {
	const short = (value: string) => value.length < 3;

	test('keeps the annotation and adds to the check', () => {
		for (const [inner, metadata] of [
			[field.string(), { kind: 'string', nullable: false }],
			[field.string({ maxBytes: 8 }), { kind: 'string', nullable: false }],
			[
				field.reference('pages'),
				{ kind: 'reference', nullable: false, target: 'pages' },
			],
		] as const) {
			const refined = Type.Refine(inner, short);
			expect(fieldMetadataOf(refined)).toEqual(metadata as FieldMetadata);
			expect(check(refined, 'ab')).toBe(true);
			expect(check(refined, 'abc')).toBe(false);
		}
		// The byte ceiling the helper added is still there.
		const both = Type.Refine(field.string({ maxBytes: 2 }), () => true);
		expect(check(both, 'abc')).toBe(false);
	});

	test('works over a json field', () => {
		const refined = Type.Refine(field.json(jsonValue), () => true);
		expect(fieldMetadataOf(refined)).toEqual({ kind: 'json', nullable: false });
		expect(check(refined, { a: 1 })).toBe(true);
		expect(check(refined, new Date())).toBe(false);
	});
});
