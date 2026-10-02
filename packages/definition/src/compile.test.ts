/**
 * Declaration Compiler Tests
 *
 * The compiler turns a declaration into field checks without knowing which
 * storage will use it. A storage with live bodies declares a body conversion;
 * the compiler carries it through unread, and a storage without one sees that
 * it is there and decides what to do.
 *
 * Key behaviors:
 * - A table goes through `defineTable`, which leaves its fields exact
 * - A declared body conversion needs both verbs and is carried through as
 *   declared; a table without one compiles with none
 * - Compilation is memoized on the definition object
 * - A field is any native TypeBox schema: raw, helper-built, or read back from
 *   JSON
 * - The schema alone decides conformance; a hint that is absent, wrong, or
 *   unknown changes the editor and nothing else
 * - Every field holds a value to JSON before its schema runs, in `check`,
 *   `issues`, `conformance`, and `inputIssues`
 * - A field owns its diagnostics: `conformance` and `inputIssues` report what
 *   `issues` returns, and a value the check refuses is an issue even when
 *   TypeBox's error report is capped to nothing
 * - Each prepared field is TypeBox's own compile of a read-only schema, and its
 *   editor is resolved from that same schema
 * - Conformance checks every declared field on its own
 * - A native `default` annotation is admitted and inert: it fills nothing, and
 *   a missing declared field is still an issue
 * - A frozen declared schema compiles with every check it had
 *
 * See also:
 * - `field/field.test.ts` for the helpers and the editor resolver on their own
 * - `packages/app/src/data/definition/compile.test.ts` for the same compiler
 *   bound to a Yjs body codec
 */
import { expect, test } from 'bun:test';
import { type TSchema, Type } from 'typebox';
import { Compile } from 'typebox/compile';
import { Settings } from 'typebox/system';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	compileData,
	type DataDefinition,
	defineTable,
	FIELD_KEYWORD,
	type FieldMap,
	field,
	isJsonSafe,
	jsonValue,
} from './index.js';

/** Compile one bucket of fields as a definition's kv. */
const compileKv = (kv: FieldMap) =>
	compileData({ id: 'so.epicenter.fields', kv, tables: {} });

const body = { encode: () => 'text', decode: (text: string) => text };

const definition: DataDefinition = {
	id: 'so.epicenter.shared',
	kv: { theme: field.string() },
	tables: {
		notes: defineTable({ fields: { title: field.string() }, body }),
		queries: defineTable({
			fields: { name: field.string(), limit: field.nullable(field.integer()) },
		}),
	},
};

const Node = Type.Cyclic(
	{
		Node: Type.Object({
			value: Type.Number(),
			next: Type.Union([Type.Ref('Node'), Type.Null()]),
		}),
	},
	'Node',
);

// ============================================================================
// Declarations
// ============================================================================

test('a declared body conversion is carried through unread, and a table without one has none', () => {
	const compiled = expectOk(compileData(definition));
	expect(compiled.tables.get('notes')?.body).toBe(body);
	expect(compiled.tables.get('queries')?.body).toBeUndefined();
	expect(compiled.kv.body).toBeUndefined();
	expect([...(compiled.tables.get('queries')?.fields.keys() ?? [])]).toEqual([
		'name',
		'limit',
	]);
	const limit = compiled.tables.get('queries')?.fields.get('limit');
	expect(limit?.editor).toEqual({ kind: 'integer', nullable: true });
	expect(limit?.check(null)).toBe(true);
	expect(limit?.check('3')).toBe(false);
});

test('compilation is memoized on the definition object', () => {
	expect(compileData(definition)).toBe(compileData(definition));
	expect(compileData({ ...definition })).not.toBe(compileData(definition));
});

test('a body conversion missing a verb, and an unknown table option, are malformed', () => {
	const half = expectErr(
		compileData({
			...definition,
			tables: {
				notes: defineTable({
					fields: {},
					// @ts-expect-error A conversion declares both verbs.
					body: { encode: body.encode },
				}),
			},
		}),
	);
	expect(half.message).toContain('invalid body codec');
	const extra = expectErr(
		compileData({
			...definition,
			tables: {
				// @ts-expect-error A table declares fields and a body only.
				notes: defineTable({ fields: {}, attachments: true }),
			},
		}),
	);
	expect(extra.message).toContain('unknown option');
});

test('field and table names keep their grammar for raw schemas', () => {
	for (const name of ['id', 'ID', '1st', 'a-b', ''])
		expect(expectErr(compileKv({ [name]: Type.String() })).name).toBe(
			'Malformed',
		);
	expect(
		expectErr(
			compileData({
				id: 'so.epicenter.names',
				kv: {},
				tables: { kv: defineTable({ fields: { a: Type.String() } }) },
			}),
		).name,
	).toBe('Malformed');
});

// ============================================================================
// A field is a native schema
// ============================================================================

test('raw native schemas compile, validate, and get the JSON editor', () => {
	const kv = expectOk(
		compileKv({
			meta: Type.Object(
				{ author: Type.String(), words: Type.Optional(Type.Integer()) },
				{ additionalProperties: false },
			),
			size: Type.Enum(['small', 'large']),
			anything: Type.Any(),
			short: Type.Refine(Type.String(), (value) => value.length < 3),
			maybe: Type.Union([Type.Number(), Type.Null()]),
			written: { type: 'string', minLength: 2 },
			chain: Node,
		}),
	).kv;
	const verdicts = (name: string, values: unknown[]) =>
		values.map((value) => kv.fields.get(name)?.check(value));

	expect(
		verdicts('meta', [
			{ author: 'a' },
			{ author: 'a', words: 2 },
			{ author: 1 },
			{ author: 'a', extra: 1 },
		]),
	).toEqual([true, true, false, false]);
	expect(verdicts('size', ['small', 'medium', 1])).toEqual([
		true,
		false,
		false,
	]);
	expect(verdicts('anything', [null, 1, 'x', { a: [1] }])).toEqual([
		true,
		true,
		true,
		true,
	]);
	expect(verdicts('short', ['ab', 'abc', 1])).toEqual([true, false, false]);
	expect(verdicts('maybe', [1, null, 'x'])).toEqual([true, true, false]);
	expect(verdicts('written', ['ab', 'a'])).toEqual([true, false]);
	expect(
		verdicts('chain', [
			{ value: 1, next: { value: 2, next: null } },
			{ value: 1, next: { value: '2', next: null } },
		]),
	).toEqual([true, false]);

	// No hint, so no editor is guessed: not a select for the enum, not a
	// string editor for the string.
	for (const [name, each] of kv.fields)
		expect(each.editor).toEqual({
			kind: 'json',
			nullable: ['anything', 'maybe'].includes(name),
		});
});

test('a field that is not a schema object is refused', () => {
	for (const bare of ['string', 7, true, null, undefined, [], new Map()]) {
		// The type refuses these too; see `declaration.test-d.ts`.
		const error = expectErr(compileKv({ title: bare as never }));
		expect(error).toMatchObject({
			name: 'UnrecognizedField',
			table: 'kv',
			field: 'title',
		});
	}
});

test('a helper schema read back from JSON compiles to the same field', () => {
	const declared = {
		title: field.string({ minLength: 2 }),
		page: field.nullable(field.reference('pages')),
		status: field.select(['draft', 'published']),
		labels: field.multiSelect(['a', 'b'], { uniqueItems: true }),
		due: field.nullable(field.instant()),
		day: field.date(),
		home: field.url(),
		rating: field.integer({ minimum: 1, maximum: 5 }),
		done: field.boolean(),
		tags: field.tags(),
		extra: field.json(Type.Object({ by: Type.String() })),
	};
	const original = expectOk(compileKv(declared)).kv;
	const restored = expectOk(
		compileKv(JSON.parse(JSON.stringify(declared)) as FieldMap),
	).kv;
	const samples = [
		null,
		true,
		3,
		9,
		2.5,
		'',
		'a',
		'draft',
		'https://epicenter.so/',
		'2026-06-09',
		'2026-06-09T14:00:00.000Z',
		[],
		['a', 'a'],
		['c'],
		{ by: 'x' },
		{ by: 1 },
		new Date(),
	];
	for (const [name, each] of original.fields) {
		const again = restored.fields.get(name);
		expect(again?.editor).toEqual(each.editor);
		for (const value of samples) {
			expect(again?.check(value)).toBe(each.check(value));
			expect(again?.issues(value)).toEqual(each.issues(value));
		}
	}
	const stored = { title: 'a', status: 'archived', labels: ['a'], done: true };
	expect(restored.conformance(stored)).toEqual(original.conformance(stored));
});

test('a spread or rebuilt helper schema is admitted with the keywords it has', () => {
	const title = field.string({ minLength: 2 });
	const kv = expectOk(
		compileKv({
			spread: { ...title },
			unsafe: Type.Unsafe(title),
			optioned: Type.Options(title, {}),
			handwritten: { type: 'string', [FIELD_KEYWORD]: { kind: 'string' } },
		}),
	).kv;
	for (const each of kv.fields.values()) {
		expect(each.editor).toEqual({ kind: 'string', nullable: false });
		expect(each.check('ab')).toBe(true);
		expect(each.check(2)).toBe(false);
	}
	expect(kv.fields.get('spread')?.check('a')).toBe(false);
});

// ============================================================================
// The editor
// ============================================================================

test('a prepared field carries the editor resolved from its schema', () => {
	const kv = expectOk(
		compileKv({
			status: field.nullable(field.select(['draft', 'published'])),
			page: field.nullable(field.reference('pages')),
			rating: field.integer({ minimum: 1, maximum: 5 }),
			score: field.number(),
			labels: field.multiSelect(['a', 'b']),
		}),
	).kv;
	const status = kv.fields.get('status');
	expect(status?.editor).toEqual({
		kind: 'select',
		nullable: true,
		options: ['draft', 'published'],
	});
	expect(status?.check(null)).toBe(true);
	expect(status?.check('archived')).toBe(false);
	expect(kv.fields.get('page')?.editor).toEqual({
		kind: 'reference',
		nullable: true,
		target: 'pages',
	});
	expect(kv.fields.get('page')?.check('')).toBe(false);
	expect(kv.fields.get('labels')?.editor).toEqual({
		kind: 'multiSelect',
		nullable: false,
		options: ['a', 'b'],
	});
	expect(kv.fields.get('rating')?.editor.kind).toBe('integer');
	expect(kv.fields.get('score')?.editor.kind).toBe('number');
	expect(kv.fields.get('rating')?.check(2.5)).toBe(false);
	expect(kv.fields.get('score')?.check(2.5)).toBe(true);
	expect(kv.fields.get('score')?.check(Number.NaN)).toBe(false);
});

test('a hint never changes checks, issues, or conformance', () => {
	const samples = [
		null,
		'',
		'draft',
		'archived',
		3,
		['draft'],
		{ a: 1 },
		new Date(),
		undefined,
	];
	const stored = { value: 'archived' };
	const bases: (() => TSchema)[] = [
		() => Type.Enum(['draft', 'published']),
		() => Type.String({ minLength: 1 }),
		() => Type.Union([Type.Enum(['draft', 'published']), Type.Null()]),
		() => Type.Array(Type.Enum(['draft', 'published'])),
	];
	const hints: unknown[] = [
		{ kind: 'select' },
		{ kind: 'string' },
		{ kind: 'integer' },
		{ kind: 'multiSelect' },
		{ kind: 'reference', target: 'pages' },
		{ kind: 'reference' },
		{ kind: 'blob' },
		{ kind: 'select', nullable: true, options: ['archived'] },
		'select',
		null,
		7,
	];
	for (const base of bases) {
		const plain = expectOk(compileKv({ value: base() })).kv;
		const expected = plain.fields.get('value');
		expect(expected?.editor.kind).toBe('json');
		for (const hint of hints) {
			const hinted = expectOk(
				compileKv({ value: { ...base(), [FIELD_KEYWORD]: hint } }),
			).kv;
			const actual = hinted.fields.get('value');
			for (const value of samples) {
				expect(actual?.check(value)).toBe(expected?.check(value) as boolean);
				expect(actual?.issues(value)).toEqual(expected?.issues(value));
			}
			expect(actual?.editor.nullable).toBe(
				expected?.editor.nullable as boolean,
			);
			expect(hinted.conformance(stored)).toEqual(plain.conformance(stored));
			expect(hinted.conformance({})).toEqual(plain.conformance({}));
			expect(hinted.inputIssues(stored, { complete: true })).toEqual(
				plain.inputIssues(stored, { complete: true }),
			);
		}
	}
});

test('a hint the schema has no shape for falls back to the JSON editor and keeps the check', () => {
	const kv = expectOk(
		compileKv({
			count: Type.Integer({ [FIELD_KEYWORD]: { kind: 'select' } }),
			text: Type.String({ [FIELD_KEYWORD]: { kind: 'tags' } }),
			either: Type.Union([field.string(), field.integer()]),
			unknown: Type.String({ [FIELD_KEYWORD]: { kind: 'blob' } }),
			accessor: Object.defineProperty(Type.String(), FIELD_KEYWORD, {
				enumerable: true,
				get: () => ({ kind: 'url' }),
			}),
		}),
	).kv;
	for (const each of kv.fields.values())
		expect(each.editor).toEqual({ kind: 'json', nullable: false });
	expect(kv.fields.get('count')?.check(1)).toBe(true);
	expect(kv.fields.get('count')?.check('1')).toBe(false);
	expect(kv.fields.get('text')?.check('x')).toBe(true);
	expect(kv.fields.get('text')?.check(['x'])).toBe(false);
	expect(kv.fields.get('either')?.check(1.5)).toBe(false);
});

test('a conflicting, composed, or unusable hint compiles to the JSON editor and validates as the schema says', () => {
	const select = { [FIELD_KEYWORD]: { kind: 'select' } };
	const kv = expectOk(
		compileKv({
			// A malformed root hint is not replaced by the member's select.
			rootNull: Type.Union([field.select(['a']), Type.Null()], {
				[FIELD_KEYWORD]: null,
			}),
			// An enum of strings on a numeric schema admits nothing.
			numericEnum: Type.Number({ enum: ['draft'], ...select }),
			numericItems: Type.Array(Type.Number({ enum: ['draft'] }), {
				[FIELD_KEYWORD]: { kind: 'multiSelect' },
			}),
			// A root `type` beside the union decides the field, so the member's
			// hint is not inherited and the root's is not honored.
			sibling: {
				type: 'string',
				anyOf: [Type.Number(), Type.Null()],
				[FIELD_KEYWORD]: { kind: 'number' },
			},
			inherited: { type: 'string', anyOf: [field.number(), Type.Null()] },
			badTarget: Type.String({
				[FIELD_KEYWORD]: { kind: 'reference', target: 'a | `b`' },
			}),
			// The schema's format is not the one a date widget writes.
			emailDate: Type.String({
				format: 'email',
				[FIELD_KEYWORD]: { kind: 'date' },
			}),
		}),
	).kv;
	const editors = Object.fromEntries(
		[...kv.fields].map(([name, each]) => [name, each.editor]),
	);
	expect(editors).toEqual({
		rootNull: { kind: 'json', nullable: true },
		numericEnum: { kind: 'json', nullable: false },
		numericItems: { kind: 'json', nullable: false },
		sibling: { kind: 'json', nullable: false },
		inherited: { kind: 'json', nullable: false },
		badTarget: { kind: 'json', nullable: false },
		emailDate: { kind: 'json', nullable: false },
	});
	expect(kv.fields.get('emailDate')?.check('a@epicenter.so')).toBe(true);
	expect(kv.fields.get('emailDate')?.check('2026-06-09')).toBe(false);
	expect(kv.fields.get('rootNull')?.check('a')).toBe(true);
	expect(kv.fields.get('rootNull')?.check('b')).toBe(false);
	for (const value of ['draft', 1])
		expect(kv.fields.get('numericEnum')?.check(value)).toBe(false);
	expect(kv.fields.get('numericItems')?.check(['draft'])).toBe(false);
	expect(kv.fields.get('numericItems')?.check([])).toBe(true);
	for (const name of ['sibling', 'inherited'])
		for (const value of ['x', 1, null])
			expect(kv.fields.get(name)?.check(value)).toBe(false);
	expect(kv.fields.get('badTarget')?.check('row')).toBe(true);
});

test('an enum edited before compilation is what the check and the options follow', () => {
	const status = field.select(['draft', 'published']);
	(status.enum as string[]).splice(0, 1, 'archived');
	const labels = field.nullable(field.multiSelect(['a', 'b']));
	(labels.anyOf[0].items.enum as string[]).push('c');
	const kv = expectOk(compileKv({ status, labels })).kv;

	expect(kv.fields.get('status')?.editor).toEqual({
		kind: 'select',
		nullable: false,
		options: ['archived', 'published'],
	});
	expect(kv.fields.get('status')?.check('archived')).toBe(true);
	expect(kv.fields.get('status')?.check('draft')).toBe(false);
	expect(kv.fields.get('labels')?.editor).toEqual({
		kind: 'multiSelect',
		nullable: true,
		options: ['a', 'b', 'c'],
	});
	expect(kv.fields.get('labels')?.check(['c'])).toBe(true);
});

test('nullability is whether the compiled field admits null', () => {
	const kv = expectOk(
		compileKv({
			helper: field.nullable(field.string()),
			plain: field.nullable(Type.Object({ a: Type.Number() })),
			native: Type.Union([Type.Null(), field.url()]),
			typed: { type: ['string', 'null'] },
			any: jsonValue,
			required: field.string(),
			// A hint cannot make a field nullable.
			claimed: Type.String({
				[FIELD_KEYWORD]: { kind: 'string', nullable: true },
			}),
		}),
	).kv;
	const editors = Object.fromEntries(
		[...kv.fields].map(([name, each]) => [name, each.editor]),
	);
	expect(editors).toEqual({
		helper: { kind: 'string', nullable: true },
		plain: { kind: 'json', nullable: true },
		native: { kind: 'url', nullable: true },
		typed: { kind: 'json', nullable: true },
		any: { kind: 'json', nullable: true },
		required: { kind: 'string', nullable: false },
		claimed: { kind: 'string', nullable: false },
	});
	for (const each of kv.fields.values())
		expect(each.check(null)).toBe(each.editor.nullable);
	expect(kv.fields.get('plain')?.check({ a: 1 })).toBe(true);
	expect(kv.fields.get('plain')?.check({ a: '1' })).toBe(false);
});

test('hidden validation keywords prevent nullable editor read-through', () => {
	const root = Type.Union([field.select(['a']), Type.Null()]);
	Object.defineProperty(root, 'type', { value: 'number' });
	const member = Type.Null();
	Object.defineProperty(member, 'enum', { value: [1] });
	const union = Type.Union([field.select(['a']), member]);
	const kv = expectOk(compileKv({ root, union })).kv;

	for (const [name, schema] of Object.entries({ root, union })) {
		const compiled = kv.fields.get(name);
		const native = Compile(schema);
		expect(compiled?.editor).toEqual({ kind: 'json', nullable: false });
		for (const value of ['a', null, 1])
			expect(compiled?.check(value)).toBe(native.Check(value));
	}
});

// ============================================================================
// Native validation
// ============================================================================

test('a native refinement is preserved, alone, over a helper, and nested', () => {
	const refused = Type.Refine(Type.Object({ a: Type.String() }), () => false);
	const kv = expectOk(
		compileKv({
			short: Type.Refine(
				field.string({ minLength: 1 }),
				(value) => value.length < 3,
				'must be shorter than 3',
			),
			optional: field.nullable(
				Type.Refine(field.reference('pages'), (value) => value !== 'home'),
			),
			payload: field.json(refused),
			list: field.nullable(Type.Array(refused)),
		}),
	).kv;
	const short = kv.fields.get('short');
	expect(short?.editor).toEqual({ kind: 'string', nullable: false });
	expect(short?.check('ab')).toBe(true);
	expect(short?.check('abc')).toBe(false);
	// What the helper built is still there under the refinement.
	expect(short?.check('')).toBe(false);
	expect(short?.issues('abc')).toEqual([
		{
			field: 'short',
			message: 'short does not conform: must be shorter than 3',
		},
	]);
	expect(short?.issues('ab')).toEqual([]);

	const optional = kv.fields.get('optional');
	expect(optional?.editor).toEqual({
		kind: 'reference',
		nullable: true,
		target: 'pages',
	});
	expect(optional?.check('about')).toBe(true);
	expect(optional?.check('home')).toBe(false);
	expect(optional?.check(null)).toBe(true);

	expect(kv.fields.get('payload')?.check({ a: 'x' })).toBe(false);
	expect(kv.fields.get('list')?.check([{ a: 'x' }])).toBe(false);
	expect(kv.fields.get('list')?.check([])).toBe(true);
	expect(kv.fields.get('list')?.check(null)).toBe(true);
});

test('nested errors keep their own messages and paths', () => {
	const Author = Type.Object({ name: Type.String({ minLength: 2 }) });
	const shape = Type.Object({
		by: Author,
		tags: Type.Array(Type.String()),
	});
	const kv = expectOk(
		compileKv({
			raw: shape,
			wrapped: field.json(shape),
			other: field.string(),
		}),
	).kv;
	const value = { by: { name: 'x' }, tags: ['a', 2] };
	const native = Compile(shape)
		.Errors(value)
		.map((error) => error.message);
	expect(native.length).toBe(2);
	for (const name of ['raw', 'wrapped']) {
		const expected = [
			{
				field: name,
				path: '/by/name',
				message: `${name} does not conform at /by/name: ${native[0]}`,
			},
			{
				field: name,
				path: '/tags/1',
				message: `${name} does not conform at /tags/1: ${native[1]}`,
			},
		];
		// The field's own diagnostics are what the table reports.
		expect(kv.fields.get(name)?.issues(value)).toEqual(expected);
		const issues = kv.conformance({ [name]: value, other: 'kept' });
		expect(issues.conforming).toEqual({ other: 'kept' });
		expect(issues.issues.filter((issue) => issue.field === name)).toEqual(
			expected,
		);
		expect(
			kv
				.inputIssues({ [name]: value }, { complete: false })
				.map((issue) => issue.path),
		).toEqual(['/by/name', '/tags/1']);
	}
});

test('a schema TypeBox cannot compile names its table and field', () => {
	for (const broken of [
		field.json({ type: 'string', pattern: '[' }),
		{ type: 'string', pattern: '[' },
	]) {
		const error = expectErr(compileKv({ title: broken }));
		expect(error).toMatchObject({
			name: 'UnrecognizedField',
			table: 'kv',
			field: 'title',
		});
		expect(error.message).toContain('regular expression');
	}
});

test('a throwing native refinement leaves valid sibling fields readable', () => {
	const payload = { title: 'Keep this', meta: {} };
	const kv = expectOk(
		compileKv({
			title: field.string(),
			meta: Type.Refine(Type.Object({}), () => {
				throw new TypeError('broken refinement');
			}),
		}),
	).kv;

	expect(kv.fields.get('meta')?.check(payload.meta)).toBe(false);
	expect(kv.fields.get('meta')?.issues(payload.meta)).toEqual([
		{
			field: 'meta',
			message: 'meta does not conform: schema validation threw',
		},
	]);
	expect(kv.conformance(payload)).toEqual({
		conforming: { title: 'Keep this' },
		issues: [
			{
				field: 'meta',
				message: 'meta does not conform: schema validation threw',
			},
		],
	});
	expect(kv.inputIssues(payload, { complete: true })).toEqual([
		{
			field: 'meta',
			message: 'meta does not conform: schema validation threw',
		},
	]);
	expect(payload).toEqual({ title: 'Keep this', meta: {} });
});

test('a refinement that throws on null is reported at the declaration', () => {
	const error = expectErr(
		compileKv({
			title: Type.Refine(Type.Any(), (value) => value.length < 3),
		}),
	);
	expect(error).toMatchObject({ name: 'UnrecognizedField', field: 'title' });
});

// ============================================================================
// JSON safety
// ============================================================================

const loop: Record<string, unknown> = { value: 1 };
loop.next = loop;

class Point {
	x = 1;
}

test('every field holds a value to JSON, whatever its schema admits', () => {
	// The control: these native schemas alone admit a Date.
	expect(Compile(Type.Any()).Check(new Date())).toBe(true);
	expect(Compile(Type.Object({})).Check(new Point())).toBe(true);

	const kv = expectOk(
		compileKv({
			any: Type.Any(),
			unknown: Type.Unknown(),
			open: jsonValue,
			wrapped: field.json(jsonValue),
			object: Type.Object({}),
			unsafe: Type.Unsafe<Date>({}),
			optional: field.nullable(jsonValue),
			list: Type.Array(Type.Any()),
		}),
	).kv;
	const unsafe = [
		new Date(),
		undefined,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		loop,
		new Point(),
		new Map(),
		() => 1,
		1n,
		Symbol('s'),
		{ nested: [new Date()] },
		{ nested: undefined },
		[undefined],
		[new Date()],
	];
	for (const [name, each] of kv.fields) {
		for (const value of unsafe) {
			expect(each.check(value)).toBe(false);
			expect(each.issues(value)).toEqual([
				{
					field: name,
					message: `${name} does not conform: must be a JSON value`,
				},
			]);
			expect(kv.conformance({ [name]: value } as never)).toMatchObject({
				conforming: {},
			});
			expect(kv.inputIssues({ [name]: value }, { complete: false })).toEqual([
				{
					field: name,
					message: `${name} does not conform: must be a JSON value`,
				},
			]);
		}
	}
	for (const name of ['any', 'unknown', 'open', 'wrapped', 'optional'])
		for (const value of [1, 'x', true, null, { a: [1, null] }, [1, 2]]) {
			expect(kv.fields.get(name)?.check(value)).toBe(true);
			expect(kv.fields.get(name)?.issues(value)).toEqual([]);
		}

	// A storage hands conformance whatever it read; the cast stands in for that.
	const stored = { open: new Date(), any: 1, optional: null } as never;
	const result = kv.conformance(stored);
	expect(result.conforming).toEqual({ any: 1, optional: null });
	expect(result.issues).toContainEqual({
		field: 'open',
		message: 'open does not conform: must be a JSON value',
	});
});

test('a cyclic value stops at the JSON check and never reaches a recursive schema', () => {
	// The control: the recursive schema alone overflows on a cyclic value, and
	// a refinement over it runs too late to help.
	expect(() => Compile(Node).Check(loop)).toThrow(RangeError);
	const after = Compile(Type.Refine(Node, isJsonSafe));
	expect(() => after.Check(loop)).toThrow(RangeError);
	expect(() => after.Errors(loop)).toThrow(RangeError);

	// A refinement that counts its calls: zero means the validator never ran.
	let calls = 0;
	const counted = Type.Refine(Type.Any(), () => {
		calls += 1;
		return true;
	});
	const kv = expectOk(
		compileKv({
			raw: Node,
			wrapped: field.json(Node),
			optional: field.nullable(Node),
			refined: Type.Refine(Node, () => true),
			counted,
		}),
	).kv;
	calls = 0;

	for (const [name, each] of kv.fields) {
		expect(each.check(loop)).toBe(false);
		const stored = { [name]: loop } as never;
		expect(kv.conformance(stored).conforming).toEqual({});
		expect(
			kv.conformance(stored).issues.filter((issue) => issue.field === name),
		).toEqual([
			{
				field: name,
				message: `${name} does not conform: must be a JSON value`,
			},
		]);
		for (const complete of [false, true])
			expect(
				kv
					.inputIssues({ [name]: loop }, { complete })
					.filter((issue) => issue.field === name),
			).toEqual([
				{
					field: name,
					message: `${name} does not conform: must be a JSON value`,
				},
			]);
	}
	expect(calls).toBe(0);

	const chain = { value: 1, next: { value: 2, next: null } };
	const wrong = { value: 1, next: { value: 'two', next: null } };
	for (const name of ['raw', 'wrapped', 'optional', 'refined']) {
		expect(kv.fields.get(name)?.check(chain)).toBe(true);
		expect(kv.fields.get(name)?.issues(chain)).toEqual([]);
		expect(kv.fields.get(name)?.check(wrong)).toBe(false);
		expect(kv.fields.get(name)?.issues(wrong)).not.toEqual([]);
	}
});

test('a shared acyclic value passes; being JSON has no depth or width', () => {
	const shared = { value: 2, next: null };
	const dag = { left: shared, right: shared, both: [shared, shared] };
	const wide = Object.fromEntries(
		Array.from({ length: 1025 }, (_, index) => [`key${index}`, index]),
	);
	let deep: unknown = 'bottom';
	for (let level = 0; level < 100_000; level++) deep = [deep];

	const kv = expectOk(
		compileKv({
			open: jsonValue,
			pair: Type.Object({ left: Node, right: Node, both: Type.Array(Node) }),
			chain: Node,
		}),
	).kv;
	for (const value of [dag, wide, deep]) {
		expect(kv.fields.get('open')?.check(value)).toBe(true);
		expect(kv.fields.get('open')?.issues(value)).toEqual([]);
	}
	expect(kv.fields.get('pair')?.check(dag)).toBe(true);
	// The same node at two depths of one chain is shared, not a cycle.
	expect(kv.fields.get('chain')?.check({ value: 1, next: shared })).toBe(true);
	expect(kv.conformance({ open: dag, pair: dag } as never)).toMatchObject({
		conforming: { open: dag, pair: dag },
	});
});

// ============================================================================
// Conformance
// ============================================================================

test('conformance checks every field on its own, however many fail', () => {
	const names = Array.from({ length: 12 }, (_, index) => `field${index}`);
	const kv = expectOk(
		compileKv({
			...Object.fromEntries(names.map((name) => [name, field.integer()])),
			kept: field.string(),
			payload: Type.Object({ a: Type.String() }),
			absent: field.nullable(field.string()),
		}),
	).kv;
	const payload = {
		...Object.fromEntries(names.map((name) => [name, 'not a number'])),
		kept: 'still here',
		payload: { a: 'x' },
		undeclared: true,
	};
	const { conforming, issues } = kv.conformance(payload);
	expect(conforming).toEqual({ kept: 'still here', payload: { a: 'x' } });
	expect(issues.map((issue) => issue.field)).toEqual([...names, 'absent']);
	expect(issues[0]).toEqual({
		field: 'field0',
		message: 'field0 does not conform: must be integer',
	});
	expect(issues.at(-1)).toEqual({
		field: 'absent',
		message: 'absent is missing',
	});
});

test('a value the check refuses is an issue and not conforming when TypeBox reports no errors', () => {
	// `maxErrors` caps what `Errors` collects and is process-wide, so it is put
	// back whatever happens here.
	const { maxErrors } = Settings.Get();
	Settings.Set({ maxErrors: 0 });
	try {
		// The control: the native validator refuses the value and says nothing.
		const native = Compile(Type.Integer());
		expect(native.Check('x')).toBe(false);
		expect(native.Errors('x')).toEqual([]);

		const kv = expectOk(
			compileKv({ count: field.integer(), kept: field.string() }),
		).kv;
		const undiagnosed = [{ field: 'count', message: 'count does not conform' }];
		expect(kv.fields.get('count')?.check('x')).toBe(false);
		expect(kv.fields.get('count')?.issues('x')).toEqual(undiagnosed);
		expect(kv.conformance({ count: 'x', kept: 'still here' })).toEqual({
			conforming: { kept: 'still here' },
			issues: undiagnosed,
		});
		expect(kv.inputIssues({ count: 'x' }, { complete: false })).toEqual(
			undiagnosed,
		);
		expect(kv.conformance({ count: 1, kept: 'k' }).issues).toEqual([]);
	} finally {
		Settings.Set({ maxErrors });
	}
	expect(Compile(Type.Integer()).Errors('x')).not.toEqual([]);
});

test('a native default annotation is admitted and validates like the schema without it', () => {
	const declared = {
		root: Type.String({ minLength: 2, default: 'untitled' }),
		spread: { ...field.string({ minLength: 2 }), default: 'untitled' },
		nested: Type.Object({
			theme: Type.String({ default: 'light' }),
			size: Type.Optional(Type.Integer({ default: 12 })),
		}),
		list: field.json(
			Type.Array(Type.String({ default: 'x' }), { default: [] }),
		),
		optional: field.nullable(Type.Integer({ default: 0 })),
		referenced: {
			$defs: { text: { type: 'string', default: '' } },
			$ref: '#/$defs/text',
		},
	};
	const kv = expectOk(compileKv(declared)).kv;
	const verdicts = (name: string, values: unknown[]) =>
		values.map((value) => kv.fields.get(name)?.check(value));

	expect(verdicts('root', ['ab', 'a', 3])).toEqual([true, false, false]);
	expect(verdicts('spread', ['ab', 'a'])).toEqual([true, false]);
	expect(
		verdicts('nested', [
			{ theme: 'dark' },
			{ theme: 'dark', size: 14 },
			// A nested default does not stand in for a required property.
			{},
			{ size: 14 },
			{ theme: 'dark', size: 'big' },
		]),
	).toEqual([true, true, false, false, false]);
	expect(verdicts('list', [[], ['a'], [1]])).toEqual([true, true, false]);
	expect(verdicts('optional', [null, 1, 'x'])).toEqual([true, true, false]);
	expect(verdicts('referenced', ['', 1])).toEqual([true, false]);

	// The annotation is kept on the compiled schema and changes no editor.
	expect(kv.fields.get('root')?.schema).toMatchObject({ default: 'untitled' });
	expect(kv.fields.get('spread')?.editor).toEqual({
		kind: 'string',
		nullable: false,
	});
});

test('a default initializes and recovers nothing: missing values stay missing and no payload is changed', () => {
	const kv = expectOk(
		compileKv({
			title: Type.String({ default: 'untitled' }),
			settings: Type.Object({
				theme: Type.String({ default: 'light' }),
				size: Type.Optional(Type.Integer({ default: 12 })),
			}),
			count: field.nullable(Type.Integer({ default: 0 })),
		}),
	).kv;

	// An absent field is missing, default or not.
	expect(kv.conformance({})).toEqual({
		conforming: {},
		issues: ['title', 'settings', 'count'].map((name) => ({
			field: name,
			message: `${name} is missing`,
		})),
	});
	expect(
		kv
			.inputIssues({ title: 'T' }, { complete: true })
			.map(({ field }) => field),
	).toEqual(['settings', 'count']);

	// A value that fails is reported, not replaced by the default.
	const stored = Object.freeze({
		title: 7,
		settings: Object.freeze({}),
		count: null,
	});
	const before = JSON.stringify(stored);
	const result = kv.conformance(stored);
	expect(result.conforming).toEqual({ count: null });
	expect([...new Set(result.issues.map(({ field }) => field))]).toEqual([
		'title',
		'settings',
	]);
	expect(kv.fields.get('title')?.check(undefined)).toBe(false);
	expect(kv.fields.get('settings')?.issues({})).not.toEqual([]);
	kv.inputIssues(stored, { complete: true });

	// A value that passes comes back as the same object, with nothing filled in.
	const partial = Object.freeze({ theme: 'dark' });
	const kept = kv.conformance({ title: 'T', settings: partial, count: 1 });
	expect(kept.issues).toEqual([]);
	expect(kept.conforming.settings).toBe(partial);
	expect(partial).toEqual({ theme: 'dark' });
	expect(JSON.stringify(stored)).toBe(before);
});

test('a property, a literal, and an option named default are ordinary names', () => {
	const kv = expectOk(
		compileKv({
			settings: Type.Object({
				default: Type.String(),
				nested: Type.Object({ default: Type.Boolean() }),
			}),
			choice: Type.Literal('default'),
			named: field.select(['default', 'custom']),
		}),
	).kv;
	expect(
		kv.fields
			.get('settings')
			?.check({ default: 'light', nested: { default: true } }),
	).toBe(true);
	expect(kv.fields.get('settings')?.check({ default: 1 })).toBe(false);
	expect(kv.fields.get('named')?.check('default')).toBe(true);
});

// ============================================================================
// The frozen snapshot
// ============================================================================

test('a frozen declared schema compiles with every check it had', () => {
	const refined = Object.freeze(
		Type.Refine(field.select(['draft', 'done']), (value) => value !== 'done'),
	);
	const declared = {
		helper: Object.freeze(field.select(['draft', 'done'])),
		refined,
		// Annotated again from a frozen helper, then frozen again.
		wrapped: Object.freeze(field.json(refined)),
		optional: Object.freeze(field.nullable(refined)),
	};
	const kv = expectOk(compileKv(declared)).kv;
	const verdicts = (name: string) =>
		['draft', 'done', 'archived', null].map((value) =>
			kv.fields.get(name)?.check(value),
		);

	expect(verdicts('helper')).toEqual([true, true, false, false]);
	expect(verdicts('refined')).toEqual([true, false, false, false]);
	expect(verdicts('wrapped')).toEqual([true, false, false, false]);
	expect(verdicts('optional')).toEqual([true, false, false, true]);
	expect(
		Object.fromEntries(
			[...kv.fields].map(([name, each]) => [name, each.editor]),
		),
	).toEqual({
		helper: { kind: 'select', nullable: false, options: ['draft', 'done'] },
		refined: { kind: 'select', nullable: false, options: ['draft', 'done'] },
		wrapped: { kind: 'json', nullable: false },
		optional: { kind: 'select', nullable: true, options: ['draft', 'done'] },
	});
	// The declared schemas are as they were, and the compiled ones are copies.
	expect(declared.helper['x-field']).toEqual({ kind: 'select' });
	expect(refined['x-field']).toEqual({ kind: 'select' });
	for (const [name, each] of kv.fields) {
		expect(each.schema).not.toBe(declared[name as keyof typeof declared]);
		expect(Object.isFrozen(each.schema)).toBe(true);
	}
});

test('a field is compiled from a frozen snapshot, so later edits change nothing', () => {
	const options = ['draft', 'published'];
	const payload = Type.Object({ a: Type.String() });
	const declared = {
		status: field.select(options),
		payload,
		wrapped: field.json(payload),
		refined: Type.Refine(field.string(), (value) => value.length < 3),
		optional: field.nullable(field.reference('pages')),
	};
	const kv = expectOk(compileKv(declared)).kv;

	// Everything the author still holds is an ordinary mutable schema.
	options.push('archived');
	Object.assign(payload.properties, { a: Type.Number() });
	(declared.status.enum as string[]).push('archived');
	Object.assign(declared.status, { [FIELD_KEYWORD]: { kind: 'string' } });
	Object.assign(declared.optional.anyOf[0], {
		[FIELD_KEYWORD]: { kind: 'reference', target: 'elsewhere' },
	});
	declared.optional.anyOf.pop();
	Object.assign(declared.refined, { maxLength: 1 });
	// The hidden refinement list too: empty it on the declared schema.
	Object.defineProperty(declared.refined, '~refine', { value: [] });

	const status = kv.fields.get('status');
	expect(status?.check('archived')).toBe(false);
	expect(status?.editor).toEqual({
		kind: 'select',
		nullable: false,
		options: ['draft', 'published'],
	});
	expect(kv.fields.get('optional')?.editor).toEqual({
		kind: 'reference',
		nullable: true,
		target: 'pages',
	});
	expect(kv.fields.get('optional')?.check(null)).toBe(true);
	for (const name of ['payload', 'wrapped']) {
		expect(kv.fields.get(name)?.check({ a: 'x' })).toBe(true);
		expect(kv.fields.get(name)?.check({ a: 1 })).toBe(false);
	}

	// The check and its issues read the same snapshot, so they agree.
	const refined = kv.fields.get('refined');
	expect(refined?.check('ab')).toBe(true);
	expect(refined?.issues('ab')).toEqual([]);
	expect(refined?.check('abc')).toBe(false);
	expect(refined?.issues('abc')).not.toEqual([]);

	for (const [name, each] of kv.fields) {
		expect(each.schema).not.toBe(declared[name as keyof typeof declared]);
		expect(Object.isFrozen(each)).toBe(true);
		expect(Object.isFrozen(each.schema)).toBe(true);
		expect(Object.isFrozen(each.editor)).toBe(true);
		expect(() => {
			(each.schema as { maxLength?: number }).maxLength = 0;
		}).toThrow();
	}
	expect(() => {
		(status?.editor as { kind: string }).kind = 'string';
	}).toThrow();
	expect(() =>
		(status?.editor as unknown as { options: string[] }).options.push('x'),
	).toThrow();
	const refinements = (
		refined?.schema as unknown as { '~refine': { refine: unknown }[] }
	)['~refine'];
	expect(Object.isFrozen(refinements)).toBe(true);
	expect(Object.isFrozen(refinements[0])).toBe(true);
	// A function is copied by reference and left alone.
	expect(Object.isFrozen(refinements[0]?.refine)).toBe(false);
	expect(
		Object.isFrozen((status?.schema as unknown as { enum: string[] }).enum),
	).toBe(true);
});

test('undefined annotations do not stop freezing a compiled snapshot', () => {
	const declared = Type.Object(
		{ a: Type.String() },
		{ description: undefined },
	);
	const value = expectOk(compileKv({ value: declared })).kv.fields.get('value');
	const schema = value?.schema as unknown as {
		properties: { a: { minLength?: number } };
	};
	expect(Object.isFrozen(schema.properties)).toBe(true);
	expect(Object.isFrozen(schema.properties.a)).toBe(true);
	expect(() => {
		schema.properties.a.minLength = 10;
	}).toThrow();
	expect(value?.check({ a: 'x' })).toBe(true);
	expect(value?.issues({ a: 'x' })).toEqual([]);
});

// ============================================================================
// Conformance and input issues on one table
// ============================================================================

const checked = expectOk(
	compileData({
		id: 'so.epicenter.checked',
		kv: {},
		tables: {
			rows: defineTable({
				fields: {
					title: field.string({ maxLength: 4 }),
					due: field.nullable(field.instant()),
					parent: field.reference('rows'),
					tags: field.tags(),
					extra: Type.Object({ 'a/b': Type.Array(Type.Integer()) }),
				},
			}),
		},
	}),
).tables.get('rows')!;
const conforming = {
	title: 'Milk',
	due: null,
	parent: 'row',
	tags: ['a'],
	extra: { 'a/b': [1] },
};

test('each declared field is checked by itself, and an undeclared key is not an issue', () => {
	expect(checked.conformance({ ...conforming, unknown: 1 })).toEqual({
		conforming,
		issues: [],
	});
	const partial = checked.conformance({ ...conforming, title: 3, due: 'soon' });
	// A field that fails does not take a field that validated with it.
	expect(partial.conforming).toEqual({
		parent: 'row',
		tags: ['a'],
		extra: { 'a/b': [1] },
	});
	expect([...new Set(partial.issues.map((issue) => issue.field))]).toEqual([
		'title',
		'due',
	]);
	expect(checked.conformance({}).issues.map((issue) => issue.field)).toEqual(
		Object.keys(conforming),
	);
});

test('issues agree with the value check for null, an empty reference, and a length limit', () => {
	const issuesFor = (values: Record<string, unknown>) =>
		checked.conformance({ ...conforming, ...values }).issues;
	expect(checked.fields.get('title')?.check('Milky')).toBe(false);
	expect(issuesFor({ title: 'Milky' })).toEqual([
		expect.objectContaining({ field: 'title' }),
	]);
	expect(issuesFor({ title: 'Milk' })).toEqual([]);
	expect(checked.fields.get('parent')?.check('')).toBe(false);
	expect(issuesFor({ parent: '' })).toHaveLength(1);
	expect(issuesFor({ due: null })).toEqual([]);
	// Only a nullable field accepts null.
	expect(issuesFor({ title: null }).map((issue) => issue.field)).toEqual([
		'title',
	]);
	for (const [name, declared] of checked.fields)
		for (const value of [null, '', 'Milky', 3, [], ['a', 3], {}, new Date()])
			expect(
				issuesFor({ [name]: value }).filter((issue) => issue.field === name)
					.length === 0,
			).toBe(declared.check(value));
});

test('a nested pointer is reported only where it names a location in the value', () => {
	const tags = checked.conformance({ ...conforming, tags: ['a', 3, 'c', 4] });
	expect(tags.issues.map(({ field, path }) => ({ field, path }))).toEqual([
		{ field: 'tags', path: '/1' },
		{ field: 'tags', path: '/3' },
	]);
	expect(tags.conforming).not.toHaveProperty('tags');
	// The validator joins keys unescaped, so `/a/b/1` names nothing here.
	const extra = checked.conformance({
		...conforming,
		extra: { 'a/b': [1, 'x'] },
	});
	expect(extra.issues).toHaveLength(1);
	expect(extra.issues[0]).not.toHaveProperty('path');
	// A whole-value failure carries no pointer.
	expect(checked.conformance({ ...conforming, tags: 'a' }).issues[0]).toEqual({
		field: 'tags',
		message: expect.stringContaining('tags'),
	});
});

test('supplied values are refused when undeclared or nonconforming, and a complete row when a field is absent', () => {
	expect(checked.inputIssues({ title: 'Milk' }, { complete: false })).toEqual(
		[],
	);
	expect(
		checked
			.inputIssues({ title: 3, other: 1 }, { complete: false })
			.map((issue) => issue.field),
	).toEqual(['title', 'other']);
	expect(
		checked
			.inputIssues({ title: 'Milk', due: null }, { complete: true })
			.map((issue) => issue.field),
	).toEqual(['parent', 'tags', 'extra']);
	expect(checked.inputIssues(conforming, { complete: true })).toEqual([]);
});
