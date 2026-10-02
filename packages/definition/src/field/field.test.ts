/**
 * Field Helper Tests
 *
 * A `field.*` helper returns one native TypeBox schema annotated with the
 * editor it is meant to get. These tests check the schema with TypeBox's own
 * `Compile`, never through this package's compiler, so they hold the helpers
 * to being native on their own.
 *
 * Key behaviors:
 * - Every helper annotates its schema with a JSON hint holding its kind, and a
 *   reference's target; nothing else is in the hint
 * - A helper's validation and hint survive `JSON.stringify` and `JSON.parse`
 * - The editor is resolved from the schema: options from `enum`, nullability
 *   from whether `null` is admitted
 * - A hint that is absent, unknown, malformed, or wrong for the schema's shape
 *   or `format` resolves to the JSON editor
 * - `field.nullable` and `field.json` take any native schema and keep its
 *   hidden keywords
 * - A helper copies its arguments and returns an ordinary mutable schema
 *
 * See also:
 * - `field.test-d.ts` for `Static<>` and the hint's literal types
 * - `../compile.test.ts` for the compiler that prepares these schemas
 */

import { describe, expect, test } from 'bun:test';
import { type TSchema, Type } from 'typebox';
import { Compile } from 'typebox/compile';
import { isJsonObject, isJsonSafe, isJsonValue } from '../json.js';
import { field, jsonValue } from './builders.js';
import { FIELD_KEYWORD, fieldEditorOf, type Kind } from './editor.js';

const check = (schema: TSchema, value: unknown) => Compile(schema).Check(value);

/** The editor for a schema, with nullability from TypeBox's compiled check. */
const editorOf = (schema: TSchema & object) =>
	fieldEditorOf(schema, check(schema, null));

/** What a schema is after being written out as JSON and read back. */
const roundTrip = (schema: TSchema): TSchema =>
	JSON.parse(JSON.stringify(schema));

const BUILT: Record<Kind, TSchema> = {
	string: field.string({ minLength: 2, pattern: '^[a-z]+$' }),
	reference: field.reference('pages'),
	url: field.url(),
	date: field.date(),
	instant: field.instant(),
	datetime: field.datetime(),
	select: field.select(['draft', 'published']),
	integer: field.integer({ minimum: 1, maximum: 5 }),
	number: field.number(),
	boolean: field.boolean(),
	tags: field.tags({ maxItems: 2, uniqueItems: true }),
	multiSelect: field.multiSelect(['a', 'b']),
	json: field.json(Type.Object({ author: Type.String() })),
};

/** Values that between them pass and fail every helper above. */
const SAMPLES: readonly unknown[] = [
	null,
	true,
	0,
	3,
	2.5,
	6,
	'',
	'a',
	'ab',
	'AB',
	'draft',
	'archived',
	'https://epicenter.so/',
	'not a url',
	'2026-06-09',
	'2026-02-30',
	'2026-06-09T14:00:00.000Z',
	'2026-06-09T14:00:00Z',
	'2026-06-09T14:00:00-05:00',
	[],
	['a'],
	['a', 'a'],
	['a', 'b', 'c'],
	['c'],
	[1],
	{},
	{ author: 'Braden' },
	{ author: 1 },
];

describe('every helper annotates a native schema', () => {
	for (const [kind, schema] of Object.entries(BUILT)) {
		test(`field.${kind} hints at the ${kind} editor and resolves to it`, () => {
			expect(Object.keys(schema)).toContain(FIELD_KEYWORD);
			expect(editorOf(schema)).toMatchObject({ kind, nullable: false });
		});
	}

	test('the hint holds a kind, and a target for a reference, and nothing else', () => {
		for (const [kind, schema] of Object.entries(BUILT))
			expect((schema as Record<string, unknown>)[FIELD_KEYWORD]).toEqual(
				kind === 'reference' ? { kind, target: 'pages' } : { kind },
			);
	});

	test('number and integer are distinct kinds with distinct checks', () => {
		expect(editorOf(field.number()).kind).toBe('number');
		expect(editorOf(field.integer()).kind).toBe('integer');
		expect(check(field.number(), 1.5)).toBe(true);
		expect(check(field.integer(), 1.5)).toBe(false);
		expect(check(field.number(), Number.NaN)).toBe(false);
		expect(check(field.integer({ minimum: 1, maximum: 5 }), 6)).toBe(false);
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

describe('a helper schema is the same schema after a JSON round trip', () => {
	const cases: [string, TSchema][] = [
		...Object.entries(BUILT),
		...Object.entries(BUILT).map(([kind, schema]): [string, TSchema] => [
			`nullable ${kind}`,
			field.nullable(schema),
		]),
	];
	for (const [name, schema] of cases) {
		test(`${name}: every sample validates the same, with the same errors and editor`, () => {
			const original = Compile(schema);
			const restored = Compile(roundTrip(schema));
			const verdicts = SAMPLES.map((value) => original.Check(value));
			// Each helper is exercised: something passes and something fails.
			expect(new Set(verdicts).size).toBe(2);
			expect(SAMPLES.map((value) => restored.Check(value))).toEqual(verdicts);
			for (const value of SAMPLES)
				expect(restored.Errors(value).map((error) => error.message)).toEqual(
					original.Errors(value).map((error) => error.message),
				);
			expect(editorOf(roundTrip(schema))).toEqual(editorOf(schema));
		});
	}

	test('a helper adds no hidden validation, so nothing is lost in JSON', () => {
		for (const schema of Object.values(BUILT)) {
			expect(Object.getOwnPropertyNames(schema)).not.toContain('~refine');
			expect(Object.getOwnPropertyNames(schema)).not.toContain('~codec');
		}
	});

	test('the control: a native refinement is not part of the JSON form', () => {
		const short = Type.Refine(field.string(), (value) => value.length < 3);
		expect(check(short, 'abc')).toBe(false);
		expect(check(roundTrip(short), 'abc')).toBe(true);
		// What the helper built is still there.
		expect(check(roundTrip(short), 3)).toBe(false);
		expect(editorOf(roundTrip(short)).kind).toBe('string');
	});
});

describe('options are the supported ones', () => {
	test('an option cannot replace what the helper sets', () => {
		for (const declare of [
			// @ts-expect-error the format is the helper's
			() => field.url({ format: 'email' }),
			// @ts-expect-error the type is the helper's
			() => field.string({ type: 'number' }),
			// @ts-expect-error the hint is the helper's
			() => field.string({ [FIELD_KEYWORD]: { kind: 'url' } }),
			// @ts-expect-error a default belongs to the application
			() => field.string({ default: 'untitled' }),
			// @ts-expect-error a typo is not an option
			() => field.tags({ minItem: 1 }),
			// @ts-expect-error instant owns its pattern
			() => field.instant({ pattern: '.*' }),
			// @ts-expect-error a byte ceiling is not a schema keyword
			() => field.string({ maxBytes: 4 }),
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

describe('reference', () => {
	test('the target is in the hint and the value is never empty', () => {
		const schema = field.reference('pages');
		expect(editorOf(schema)).toEqual({
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

describe('select and multiSelect', () => {
	test('the options an editor offers are the schema enum', () => {
		const status = field.select(['draft', 'published']);
		expect(status.enum).toEqual(['draft', 'published']);
		expect(editorOf(status)).toEqual({
			kind: 'select',
			nullable: false,
			options: ['draft', 'published'],
		});

		const labels = field.multiSelect(['a', 'b'], { uniqueItems: true });
		expect(editorOf(labels)).toEqual({
			kind: 'multiSelect',
			nullable: false,
			options: ['a', 'b'],
		});
		expect(check(labels, ['a', 'b'])).toBe(true);
		expect(check(labels, ['a', 'a'])).toBe(false);
		expect(check(labels, ['c'])).toBe(false);
	});

	test('changing the list that was passed in changes neither validator nor editor', () => {
		const values = ['draft', 'published'];
		const status = field.select(values);
		const labels = field.multiSelect(values);
		values.push('archived');
		values[0] = 'renamed';
		for (const schema of [status, labels])
			expect(editorOf(schema)).toMatchObject({
				options: ['draft', 'published'],
			});
		expect(check(status, 'draft')).toBe(true);
		expect(check(status, 'archived')).toBe(false);
		expect(check(labels, ['archived'])).toBe(false);
	});

	test('a native edit to the enum moves the check and the options together', () => {
		const status = field.select(['draft', 'published']);
		expect(Object.isFrozen(status)).toBe(false);
		(status.enum as string[]).push('archived');
		expect(check(status, 'archived')).toBe(true);
		expect(editorOf(status)).toMatchObject({
			options: ['draft', 'published', 'archived'],
		});
	});

	test('an empty or non-string list is refused', () => {
		expect(() => field.select([])).toThrow('at least one string option');
		// @ts-expect-error select holds strings; a numeric range is integer + min/max
		expect(() => field.select([1, 2])).toThrow('at least one string option');
		expect(() => field.multiSelect([])).toThrow('at least one string option');
	});
});

describe('the editor is resolved from the schema, and falls back to JSON', () => {
	const json = (nullable: boolean) => ({ kind: 'json', nullable }) as const;

	test('a schema with no hint gets the JSON editor, whatever its shape', () => {
		for (const bare of [
			Type.String(),
			Type.Integer(),
			Type.Boolean(),
			Type.Enum(['a', 'b']),
			Type.Array(Type.String()),
			Type.Object({ a: Type.String() }),
			Type.Refine(Type.String(), () => true),
		])
			expect(editorOf(bare)).toEqual(json(false));
		expect(editorOf(Type.Any())).toEqual(json(true));
		expect(editorOf(Type.Union([Type.String(), Type.Null()]))).toEqual(
			json(true),
		);
	});

	test('an unknown or malformed hint gets the JSON editor', () => {
		for (const hint of [
			{ kind: 'blob' },
			{ kind: 'toString' },
			{},
			{ kind: 7 },
			'string',
			['string'],
			null,
			{ kind: 'reference' },
			{ kind: 'reference', target: '' },
			{ kind: 'reference', target: 7 },
		])
			expect(editorOf(Type.String({ [FIELD_KEYWORD]: hint }))).toEqual(
				json(false),
			);
	});

	test('a hint the schema does not have the shape for gets the JSON editor', () => {
		const wrong: [Kind, TSchema][] = [
			['string', Type.Number()],
			['url', Type.Object({})],
			['date', Type.Integer()],
			['instant', Type.Array(Type.String())],
			['datetime', Type.Boolean()],
			['number', Type.Integer()],
			['integer', Type.Number()],
			['boolean', Type.String()],
			['select', Type.String()],
			['select', Type.Enum([1, 2])],
			['select', { enum: [] }],
			['multiSelect', Type.Array(Type.String())],
			['multiSelect', Type.Enum(['a'])],
			['tags', Type.Array(Type.Number())],
			['tags', Type.String()],
			// Composition is not looked into.
			['string', Type.Intersect([Type.String(), Type.String()])],
			['string', Type.Union([Type.String(), Type.Number()])],
			['string', { type: ['string', 'null'] }],
		];
		for (const [kind, schema] of wrong) {
			const hinted = { ...schema, [FIELD_KEYWORD]: { kind } };
			expect(editorOf(hinted).kind).toBe('json');
		}
		expect(
			editorOf({
				type: 'string',
				[FIELD_KEYWORD]: { kind: 'reference', target: 'pages' },
			}),
		).toEqual({ kind: 'reference', nullable: false, target: 'pages' });
	});

	test('a formatted kind is refused by another format and allowed by its own or none', () => {
		const formats = {
			url: 'uri',
			date: 'date',
			instant: 'date-time',
			datetime: 'date-time',
		} as const;
		for (const [kind, format] of Object.entries(formats)) {
			const hint = { [FIELD_KEYWORD]: { kind } };
			// The helper's own format, and a plain string that covers it.
			expect(BUILT[kind as Kind]).toMatchObject({ format });
			for (const fitting of [
				Type.String({ format, ...hint }),
				Type.String(hint),
			])
				expect(editorOf(fitting)).toMatchObject({ kind, nullable: false });
			for (const conflicting of [
				'email',
				kind === 'date' ? 'date-time' : 'date',
				7,
				null,
				undefined,
			]) {
				const schema = { type: 'string', format: conflicting, ...hint };
				expect(editorOf(schema)).toEqual(json(false));
				expect(editorOf(Type.Union([schema, Type.Null()]))).toEqual(json(true));
			}
			// A hidden format is still one TypeBox validates.
			const hidden = Type.String(hint);
			Object.defineProperty(hidden, 'format', { value: 'email' });
			expect(editorOf(hidden)).toEqual(json(false));
		}
		// The hint was never the check: the schema still validates as an email.
		const email = Type.String({
			format: 'email',
			[FIELD_KEYWORD]: { kind: 'date' },
		});
		expect(check(email, 'a@epicenter.so')).toBe(true);
		expect(check(email, '2026-06-09')).toBe(false);
		// `string` and `reference` name no format, so a format is one more
		// constraint on the text their widgets edit.
		expect(
			editorOf(
				Type.String({ format: 'email', [FIELD_KEYWORD]: { kind: 'string' } }),
			),
		).toEqual({ kind: 'string', nullable: false });
		expect(
			editorOf(
				Type.String({
					format: 'uuid',
					[FIELD_KEYWORD]: { kind: 'reference', target: 'pages' },
				}),
			),
		).toEqual({ kind: 'reference', nullable: false, target: 'pages' });
	});

	test('a hand-written hint on a fitting schema is honored', () => {
		expect(
			editorOf(Type.Enum(['a', 'b'], { [FIELD_KEYWORD]: { kind: 'select' } })),
		).toEqual({ kind: 'select', nullable: false, options: ['a', 'b'] });
		// Extra keys in a hint are ignored and are not carried into the editor.
		expect(
			editorOf(
				Type.String({
					[FIELD_KEYWORD]: { kind: 'url', nullable: true, options: ['x'] },
				}),
			),
		).toEqual({ kind: 'url', nullable: false });
	});

	test('an inherited or accessor hint reads as absent', () => {
		const accessor = Type.String();
		Object.defineProperty(accessor, FIELD_KEYWORD, {
			enumerable: true,
			get: () => ({ kind: 'url' }),
		});
		expect(editorOf(accessor).kind).toBe('json');
	});

	test('nullability is what the schema admits, not what a hint says', () => {
		expect(editorOf(field.string()).nullable).toBe(false);
		expect(editorOf(field.nullable(field.string())).nullable).toBe(true);
		expect(editorOf(field.json(jsonValue))).toEqual(json(true));
		expect(editorOf(field.json(Type.Object({})))).toEqual(json(false));
		// The resolver takes the caller's answer and asks no validator itself.
		expect(fieldEditorOf(field.string(), true)).toEqual({
			kind: 'string',
			nullable: true,
		});
	});

	test('a root hint that is present but unusable is not replaced by a member hint', () => {
		const accessor = Type.Union([field.select(['a']), Type.Null()]);
		Object.defineProperty(accessor, FIELD_KEYWORD, {
			enumerable: true,
			get: () => ({ kind: 'select' }),
		});
		const hidden = Type.Union([field.select(['a']), Type.Null()]);
		Object.defineProperty(hidden, FIELD_KEYWORD, { value: 7 });
		for (const union of [
			accessor,
			hidden,
			...[null, undefined, 'select', 7, {}, { kind: 'blob' }].map((hint) =>
				Type.Union([field.select(['a']), Type.Null()], {
					[FIELD_KEYWORD]: hint,
				}),
			),
		])
			expect(editorOf(union)).toEqual(json(true));
		// The control: with no root hint at all, the member's is used.
		expect(editorOf(Type.Union([field.select(['a']), Type.Null()]))).toEqual({
			kind: 'select',
			nullable: true,
			options: ['a'],
		});
	});

	test('an enum beside a conflicting type is not a select', () => {
		const select = { [FIELD_KEYWORD]: { kind: 'select' } };
		const multiSelect = { [FIELD_KEYWORD]: { kind: 'multiSelect' } };
		for (const schema of [
			Type.Number({ enum: ['draft'], ...select }),
			{ type: ['string', 'null'], enum: ['draft'], ...select },
			{ type: 'array', enum: ['draft'], ...select },
			Type.Array(Type.Number({ enum: ['draft'] }), multiSelect),
			Type.Array({ enum: ['draft'], anyOf: [Type.String()] }, multiSelect),
			{ type: 'object', items: { enum: ['draft'] }, ...multiSelect },
			Type.Union([Type.Number({ enum: ['draft'], ...select }), Type.Null()]),
		])
			expect(editorOf(schema).kind).toBe('json');
		// An enum with a string type, or with no type, is still a select.
		for (const schema of [
			{ enum: ['draft'], ...select },
			{ type: 'string', enum: ['draft'], ...select },
		])
			expect(editorOf(schema)).toEqual({
				kind: 'select',
				nullable: false,
				options: ['draft'],
			});
		expect(
			editorOf({
				type: 'array',
				items: { type: 'string', enum: ['a'] },
				...multiSelect,
			}),
		).toEqual({ kind: 'multiSelect', nullable: false, options: ['a'] });
	});

	test('a composition keyword beside a hint gets the JSON editor', () => {
		const number = { [FIELD_KEYWORD]: { kind: 'number' } };
		const string = { [FIELD_KEYWORD]: { kind: 'string' } };
		for (const schema of [
			// A root that is a union with null AND says something else.
			{ type: 'string', anyOf: [Type.Number(), Type.Null()], ...number },
			{ type: 'string', anyOf: [field.number(), Type.Null()] },
			{ anyOf: [field.number(), Type.Null()], enum: [1] },
			{ anyOf: [field.number(), Type.Null()], allOf: [Type.String()] },
			{ anyOf: [field.number(), Type.Null()], not: {} },
			{ anyOf: [field.number(), { type: 'null', not: {} }] },
			// A root or a member composed some other way.
			{ type: 'string', allOf: [Type.Number()], ...string },
			{ type: 'string', oneOf: [Type.Number()], ...string },
			{ type: 'string', not: Type.String(), ...string },
			{ type: 'string', if: {}, else: Type.Number(), ...string },
			{ type: 'string', $ref: '#/$defs/n', $defs: { n: {} }, ...string },
			Type.Union([{ type: 'string', allOf: [{}], ...string }, Type.Null()]),
			Type.Union([{ type: 'string', not: {}, ...string }, Type.Null()]),
			{
				type: 'array',
				items: { type: 'string', not: {} },
				'x-field': { kind: 'tags' },
			},
		])
			expect(editorOf(schema).kind).toBe('json');
		// Annotations beside the union say nothing about a value.
		expect(
			editorOf(
				Type.Union([field.number(), Type.Null()], {
					title: 'Count',
					description: 'How many',
					default: null,
					examples: [1],
				}),
			),
		).toEqual({ kind: 'number', nullable: true });
		// The JSON editor fits any schema, composed or not.
		expect(
			editorOf(field.json(Type.Union([Type.String(), Type.Number()]))),
		).toEqual(json(false));
	});

	test('a reference target that is not a usable table name gets the JSON editor', () => {
		for (const target of [
			'no such table',
			'a|b',
			'`x` | y',
			'pages\n| x',
			'select',
			'sqlite_master',
			'a'.repeat(65),
		]) {
			expect(() => field.reference(target)).toThrow('name of a table');
			const foreign = Type.String({
				minLength: 1,
				[FIELD_KEYWORD]: { kind: 'reference', target },
			});
			expect(editorOf(foreign)).toEqual(json(false));
			// The hint was never the check.
			expect(check(foreign, 'row')).toBe(true);
			expect(check(foreign, '')).toBe(false);
		}
	});
});

describe('a frozen schema can be annotated again', () => {
	test('field.json over a frozen helper replaces the hint and leaves the input alone', () => {
		const frozen = Object.freeze(field.select(['draft', 'done']));
		const wrapped = field.json(frozen);
		expect(wrapped[FIELD_KEYWORD]).toEqual({ kind: 'json' });
		expect(editorOf(wrapped)).toEqual({ kind: 'json', nullable: false });
		expect(check(wrapped, 'draft')).toBe(true);
		expect(check(wrapped, 'archived')).toBe(false);
		expect(frozen[FIELD_KEYWORD]).toEqual({ kind: 'select' });
		expect(Object.isFrozen(frozen)).toBe(true);
		expect(editorOf(frozen).kind).toBe('select');
	});

	test('a frozen refined helper keeps its refinement and its keywords', () => {
		const refined = Object.freeze(
			Type.Refine(field.select(['draft', 'done']), (value) => value !== 'done'),
		);
		for (const wrapped of [
			field.json(refined),
			field.json(field.json(Object.freeze(field.json(refined)))),
		]) {
			expect(wrapped[FIELD_KEYWORD]).toEqual({ kind: 'json' });
			expect(check(wrapped, 'draft')).toBe(true);
			// The refinement, then the enum.
			expect(check(wrapped, 'done')).toBe(false);
			expect(check(wrapped, 'archived')).toBe(false);
		}
		expect(refined[FIELD_KEYWORD]).toEqual({ kind: 'select' });
		expect(check(refined, 'done')).toBe(false);

		const optional = field.nullable(refined);
		expect(editorOf(optional).kind).toBe('select');
		expect(check(optional, null)).toBe(true);
		expect(check(optional, 'done')).toBe(false);
	});

	test('a deeply frozen nullable helper is wrapped without losing a check', () => {
		const inner = field.nullable(field.string({ minLength: 2 }));
		Object.freeze(inner.anyOf[0]);
		Object.freeze(inner.anyOf);
		const wrapped = field.json(Object.freeze(inner));
		expect(editorOf(wrapped)).toEqual({ kind: 'json', nullable: true });
		expect(check(wrapped, 'ab')).toBe(true);
		expect(check(wrapped, 'a')).toBe(false);
	});
});

describe('nullable', () => {
	test('it is the native union with null, and the editor reads through it', () => {
		const status = field.nullable(field.select(['draft', 'published']));
		expect(Object.keys(status)).not.toContain(FIELD_KEYWORD);
		expect(status.anyOf[0][FIELD_KEYWORD]).toEqual({ kind: 'select' });
		expect(editorOf(status)).toEqual({
			kind: 'select',
			nullable: true,
			options: ['draft', 'published'],
		});
		expect(check(status, null)).toBe(true);
		expect(check(status, 'draft')).toBe(true);
		expect(check(status, 'archived')).toBe(false);
		expect(check(status, undefined)).toBe(false);

		const page = field.nullable(field.reference('pages'));
		expect(editorOf(page)).toEqual({
			kind: 'reference',
			nullable: true,
			target: 'pages',
		});
		expect(check(page, null)).toBe(true);
		expect(check(page, '')).toBe(false);
	});

	test('it takes a plain native schema, and a native union works the same', () => {
		const plain = field.nullable(Type.String({ minLength: 2 }));
		expect(check(plain, null)).toBe(true);
		expect(check(plain, 'ab')).toBe(true);
		expect(check(plain, 'a')).toBe(false);
		expect(editorOf(plain)).toEqual({ kind: 'json', nullable: true });

		// Either member order, written without the helper.
		for (const union of [
			Type.Union([field.url(), Type.Null()]),
			Type.Union([Type.Null(), field.url()]),
		])
			expect(editorOf(union)).toEqual({ kind: 'url', nullable: true });
		// A hint on the union itself wins over its member's.
		expect(
			editorOf(
				Type.Union([field.url(), Type.Null()], {
					[FIELD_KEYWORD]: { kind: 'string' },
				}),
			),
		).toEqual({ kind: 'string', nullable: true });
	});

	test('only the simple union with null is read through', () => {
		for (const composed of [
			Type.Union([field.url(), field.string(), Type.Null()]),
			Type.Union([field.url(), field.string()]),
			field.nullable(field.nullable(field.url())),
			Type.Intersect([field.url(), Type.String()]),
		])
			expect(editorOf(composed).kind).toBe('json');
		expect(check(field.nullable(field.nullable(field.url())), null)).toBe(true);
	});

	test('the schema it wraps is copied, not changed, and never frozen', () => {
		const status = field.select(['draft']);
		field.nullable(status);
		expect(check(status, null)).toBe(false);

		const refined = Type.Refine(field.string(), (value) => value !== '');
		const wrapped = field.nullable(refined);
		expect(Object.isFrozen(refined)).toBe(false);
		Object.assign(refined, { maxLength: 1 });
		// The nullable field was built from what `refined` was at the call,
		// hidden refinement included.
		expect(check(wrapped, 'ab')).toBe(true);
		expect(check(wrapped, '')).toBe(false);
		expect(editorOf(wrapped)).toEqual({ kind: 'string', nullable: true });
	});

	test('it needs a schema', () => {
		// @ts-expect-error null is not a schema
		expect(() => field.nullable(null)).toThrow('needs a schema');
	});
});

describe('json copies the schema it is given and hints at the JSON editor', () => {
	const Author = Type.Object(
		{ author: Type.String() },
		{ additionalProperties: false },
	);
	const never = () => false;

	test('it is the schema itself plus the hint: no conditional, no gate', () => {
		const wrapped = field.json(Author);
		expect(roundTrip(wrapped)).toEqual({
			...roundTrip(Author),
			[FIELD_KEYWORD]: { kind: 'json' },
		});
		expect(Object.getOwnPropertyNames(wrapped)).not.toContain('~refine');
		expect(editorOf(wrapped)).toEqual({ kind: 'json', nullable: false });
		// Being JSON is the compiled field's question, not this schema's.
		expect(check(field.json(Type.Any()), new Date())).toBe(true);
	});

	test('an object, an array, and a nested payload are checked as declared', () => {
		expect(check(field.json(Author), { author: 'Braden' })).toBe(true);
		expect(check(field.json(Author), { author: 42 })).toBe(false);
		expect(check(field.json(Author), { author: 'x', extra: 1 })).toBe(false);

		const list = field.json(Type.Array(Author, { maxItems: 1 }));
		expect(check(list, [{ author: 'a' }])).toBe(true);
		expect(check(list, [{ author: 'a' }, { author: 'b' }])).toBe(false);

		const nested = field.nullable(
			field.json(Type.Object({ by: Author, tags: Type.Array(Type.String()) })),
		);
		expect(editorOf(nested)).toEqual({ kind: 'json', nullable: true });
		expect(check(nested, { by: { author: 'a' }, tags: ['x'] })).toBe(true);
		expect(check(nested, { by: { author: 1 }, tags: ['x'] })).toBe(false);
		expect(check(nested, null)).toBe(true);
	});

	test('the schema reports its own errors at their own paths', () => {
		const errors = Compile(
			field.json(Type.Object({ by: Author, tags: Type.Array(Type.String()) })),
		).Errors({ by: { author: 1 }, tags: ['x', 2] });
		expect(errors.map((error) => error.instancePath)).toEqual([
			'/by/author',
			'/tags/1',
		]);
	});

	test('a refinement on the schema survives, at the root and nested', () => {
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

	test('a frozen schema works and is left as it was', () => {
		const refused = Object.freeze(
			Type.Refine(Type.Object({ a: Type.String() }), never),
		);
		expect(check(field.json(refused), { a: 'x' })).toBe(false);
		const plain = Object.freeze(Type.Object({ a: Type.String() }));
		expect(check(field.json(plain), { a: 'x' })).toBe(true);
		expect(FIELD_KEYWORD in plain).toBe(false);
	});

	test('a schema changed after the call changes nothing', () => {
		const payload = Type.Object({ a: Type.String() });
		const wrapped = field.json(payload);
		Object.assign(payload.properties, { a: Type.Number() });
		expect(check(wrapped, { a: 'x' })).toBe(true);
		expect(check(wrapped, { a: 1 })).toBe(false);
	});

	test('wrapping a field replaces its editor and keeps its check', () => {
		const status = field.select(['small', 'large']);
		const wrapped = field.json(status);
		expect(editorOf(wrapped)).toEqual({ kind: 'json', nullable: false });
		expect(editorOf(status).kind).toBe('select');
		expect(check(wrapped, 'small')).toBe(true);
		expect(check(wrapped, 'medium')).toBe(false);
	});

	test('a JSON Schema written by hand is checked the same way', () => {
		const text = field.json({
			$defs: { text: { type: 'string', minLength: 2 } },
			$ref: '#/$defs/text',
		});
		for (const schema of [text, field.nullable(text)]) {
			expect(check(schema, 'yes')).toBe(true);
			expect(check(schema, 'x')).toBe(false);
			expect(check(schema, 2)).toBe(false);
		}
	});

	test('it needs a schema', () => {
		// @ts-expect-error null is not a schema
		expect(() => field.json(null)).toThrow('needs a schema');
	});
});

describe('a native refinement over a helper', () => {
	const short = (value: string) => value.length < 3;

	test('keeps the hint and what the helper built, and adds to the check', () => {
		for (const [inner, editor] of [
			[field.string(), { kind: 'string', nullable: false }],
			[
				field.reference('pages'),
				{ kind: 'reference', nullable: false, target: 'pages' },
			],
		] as const) {
			const refined = Type.Refine(inner, short);
			expect(editorOf(refined)).toEqual(editor);
			expect(check(refined, 'ab')).toBe(true);
			expect(check(refined, 'abc')).toBe(false);
			expect(check(refined, 3)).toBe(false);
		}
		expect(check(Type.Refine(field.reference('pages'), short), '')).toBe(false);
	});

	test('works over a json field and under nullable', () => {
		const refined = field.nullable(
			Type.Refine(
				field.json(Type.Array(Type.String())),
				(list) => list.length < 2,
			),
		);
		expect(editorOf(refined)).toEqual({ kind: 'json', nullable: true });
		expect(check(refined, ['a'])).toBe(true);
		expect(check(refined, ['a', 'b'])).toBe(false);
		expect(check(refined, null)).toBe(true);
	});
});

describe('being JSON has no size', () => {
	test('wide, deep, and shared values are JSON; a cycle is not', () => {
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
	});
});
