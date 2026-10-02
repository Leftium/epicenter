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
 * - A field is a `field.*` schema; a bare native schema is refused, not adopted
 * - Each prepared field is TypeBox's own compile of a read-only schema, and its
 *   annotation is read from that same schema
 * - Conformance checks every declared field on its own
 * - A declared default is refused; a payload property named `default` is not one
 *
 * See also:
 * - `packages/app/src/data/definition/compile.test.ts` for the same compiler
 *   bound to a Yjs body codec
 */
import { expect, test } from 'bun:test';
import { Type } from 'typebox';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	compileData,
	type DataDefinition,
	defineTable,
	type FieldMap,
	field,
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
	expect(limit?.nullable).toBe(true);
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

test('a bare native schema is not a field, in a table or in kv', () => {
	for (const bare of [
		Type.String(),
		Type.Union([Type.String(), Type.Null()]),
		{ type: 'string' },
		{ type: 'string', 'x-field': { kind: 'text', nullable: false } },
		'string',
		null,
	]) {
		// @ts-expect-error a field is built with field.*
		const kv = expectErr(compileKv({ title: bare }));
		expect(kv).toMatchObject({
			name: 'UnrecognizedField',
			table: 'kv',
			field: 'title',
		});
	}
	defineTable({
		fields: {
			// @ts-expect-error a field is built with field.*
			title: Type.String(),
			payload: field.json(Type.String()),
		},
	});
});

test('a prepared field carries the editor its schema declared', () => {
	const kv = expectOk(
		compileKv({
			status: field.nullable(field.select(['draft', 'published'])),
			page: field.nullable(field.reference('pages')),
			rating: field.integer({ minimum: 1, maximum: 5 }),
			score: field.number(),
		}),
	).kv;
	const status = kv.fields.get('status');
	expect(status).toMatchObject({
		name: 'status',
		kind: 'select',
		nullable: true,
		reference: null,
		metadata: {
			kind: 'select',
			nullable: true,
			options: ['draft', 'published'],
		},
	});
	expect(status?.check(null)).toBe(true);
	expect(status?.check('archived')).toBe(false);
	expect(kv.fields.get('page')).toMatchObject({
		kind: 'reference',
		nullable: true,
		reference: 'pages',
		metadata: { kind: 'reference', nullable: true, target: 'pages' },
	});
	expect(kv.fields.get('page')?.check('')).toBe(false);
	expect(kv.fields.get('rating')?.kind).toBe('integer');
	expect(kv.fields.get('score')?.kind).toBe('number');
	expect(kv.fields.get('rating')?.check(2.5)).toBe(false);
	expect(kv.fields.get('score')?.check(2.5)).toBe(true);
	expect(kv.fields.get('score')?.check(Number.NaN)).toBe(false);
});

test('a prepared field preserves native refinements and byte ceilings', () => {
	const refused = Type.Refine(Type.Object({ a: Type.String() }), () => false);
	const declared = {
		title: field.string<string>({ maxBytes: 4 }),
		payload: field.json(refused),
		list: field.nullable(field.json(Type.Array(refused))),
	};
	const kv = expectOk(compileKv(declared)).kv;
	expect(kv.fields.get('title')?.check('abcd')).toBe(true);
	expect(kv.fields.get('title')?.check('abcde')).toBe(false);
	expect(kv.fields.get('title')?.errors('abcde')).toEqual([
		'must be at most 4 UTF-8 bytes',
	]);
	expect(kv.fields.get('title')?.errors('abcd')).toEqual([]);
	expect(kv.fields.get('payload')?.check({ a: 'x' })).toBe(false);
	expect(kv.fields.get('list')?.check([{ a: 'x' }])).toBe(false);
	expect(kv.fields.get('list')?.check([])).toBe(true);
	expect(kv.fields.get('list')?.check(null)).toBe(true);
});

test('a JSON field reads only JSON', () => {
	const kv = expectOk(
		compileKv({
			open: field.json(jsonValue),
			any: field.json(Type.Any()),
			optional: field.nullable(field.json(jsonValue)),
		}),
	).kv;
	const cycle: Record<string, unknown> = {};
	cycle.self = cycle;
	for (const name of ['open', 'any', 'optional']) {
		const prepared = kv.fields.get(name);
		for (const value of [
			new Date(),
			undefined,
			Number.NaN,
			cycle,
			{ at: new Date() },
			[undefined],
		])
			expect(prepared?.check(value)).toBe(false);
		expect(prepared?.check({ a: [1, 'x', null] })).toBe(true);
	}
	expect(kv.fields.get('open')?.errors(new Date())[0]).toBe(
		'must be a JSON value',
	);
	// A storage hands conformance whatever it read; the cast stands in for that.
	const stored = { open: new Date(), any: 1, optional: null } as never;
	expect(kv.conformance(stored)).toEqual({
		conforming: { any: 1, optional: null },
		issues: [
			{
				field: 'open',
				message: 'open is not a conforming json value: must be a JSON value',
			},
		],
	});
});

test('a recursive JSON field refuses a cyclic value instead of overflowing', () => {
	const Node = Type.Cyclic(
		{
			Node: Type.Object({
				value: Type.Number(),
				next: Type.Union([Type.Ref('Node'), Type.Null()]),
			}),
		},
		'Node',
	);
	const kv = expectOk(
		compileKv({
			list: field.json(Node),
			optional: field.nullable(field.json(Node)),
		}),
	).kv;
	const loop: Record<string, unknown> = { value: 1 };
	loop.next = loop;
	for (const name of ['list', 'optional']) {
		const prepared = kv.fields.get(name);
		expect(prepared?.check(loop)).toBe(false);
		expect(prepared?.errors(loop)).toContain('must be a JSON value');
		expect(prepared?.check({ value: 1, next: { value: 2, next: null } })).toBe(
			true,
		);
		expect(prepared?.check({ value: 1, next: { value: '2' } })).toBe(false);
	}
	const stored = { list: loop, optional: null } as never;
	expect(kv.conformance(stored).issues).toHaveLength(1);
});

test('a field that lost what its helper built is refused, not compiled without it', () => {
	const bounded = field.string({ maxBytes: 4 });
	for (const lossy of [
		// A spread copies enumerable keywords, so the byte ceiling is gone.
		{ ...bounded },
		{ ...field.nullable(bounded) },
		Type.Unsafe(bounded),
		{ type: 'string', 'x-field': { kind: 'string', nullable: false } },
		Type.String({ 'x-field': { kind: 'string', nullable: false } }),
		Type.Options(field.json(Type.Object({ a: Type.String() })), {}),
	]) {
		// @ts-expect-error a field is what a helper returned
		const compiled = compileKv({ title: lossy });
		if (compiled.error === null) {
			// Whatever TypeBox carried the mark through carried the constraint too.
			expect(compiled.data.kv.fields.get('title')?.check('abcde')).toBe(false);
			continue;
		}
		expect(compiled.error).toMatchObject({
			name: 'UnrecognizedField',
			table: 'kv',
			field: 'title',
		});
		expect(compiled.error.message).toContain('hidden constraints');
	}
	// The spread above is refused; these keep the mark and the ceiling.
	const kept = expectOk(
		compileKv({
			refined: Type.Refine(bounded, () => true),
			optional: field.nullable(bounded),
		}),
	).kv;
	expect(kept.fields.get('refined')?.check('abcde')).toBe(false);
	expect(kept.fields.get('optional')?.check('abcde')).toBe(false);
});

test('conformance checks every field on its own, however many fail', () => {
	const names = Array.from({ length: 12 }, (_, index) => `field${index}`);
	const kv = expectOk(
		compileKv({
			...Object.fromEntries(names.map((name) => [name, field.integer()])),
			kept: field.string(),
			payload: field.json(Type.Object({ a: Type.String() })),
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
		message: 'field0 is not a conforming integer value: must be integer',
	});
	expect(issues.at(-1)).toEqual({
		field: 'absent',
		message: 'absent is missing',
	});
});

test('a declared default is refused; a property named default is not one', () => {
	for (const withDefault of [
		{ ...field.string(), default: 'untitled' },
		field.json(Type.Object({ a: Type.String({ default: 'x' }) })),
		field.json(Type.Array(Type.String(), { default: [] })),
		field.nullable(field.json(Type.Object({}, { default: {} }))),
		field.json({ not: { default: 1 } }),
		field.json({ if: {}, else: { default: 1 } }),
		field.json({ prefixItems: [{}, { default: 1 }] }),
		field.json({ additionalProperties: { default: 1 } }),
		field.json(
			Type.Object({}, { unevaluatedProperties: Type.String({ default: 'x' }) }),
		),
		field.json(
			Type.Array(Type.String(), {
				unevaluatedItems: Type.String({ default: 'x' }),
			}),
		),
		field.json({ $defs: { text: { default: '' } }, $ref: '#/$defs/text' }),
	]) {
		const error = expectErr(compileKv({ value: withDefault }));
		expect(error).toMatchObject({ name: 'DeclarationDefault', field: 'value' });
	}
	const kv = expectOk(
		compileKv({
			settings: field.json(
				Type.Object({
					default: Type.String(),
					nested: Type.Object({ default: Type.Boolean() }),
				}),
			),
			choice: field.json(Type.Literal('default')),
			named: field.select(['default', 'custom']),
			// A `default` key in data, an annotation, or a name map is not a default.
			data: field.json({
				const: { default: 1 },
				enum: [{ default: 1 }],
				examples: [{ default: 1 }],
				dependentRequired: { default: ['other'] },
				'x-note': { default: 1 },
			}),
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

test('a field is compiled from a frozen snapshot, so later edits change nothing', () => {
	const options = ['draft', 'published'];
	const payload = Type.Object({ a: Type.String() });
	const declared = {
		status: field.select(options),
		payload: field.json(payload),
		bounded: field.string({ maxBytes: 4 }),
		refined: Type.Refine(field.string(), (value) => value.length < 3),
	};
	const kv = expectOk(compileKv(declared)).kv;

	// Everything the author still holds is an ordinary mutable schema.
	options.push('archived');
	Object.assign(payload.properties, { a: Type.Number() });
	declared.status.enum.push('archived' as never);
	Object.assign(declared.status, {
		'x-field': { kind: 'string', nullable: true },
	});
	Object.assign(declared.refined, { maxLength: 1 });
	// The hidden refinement list too: empty it on the declared schema.
	(declared.bounded as unknown as { '~refine': unknown[] })['~refine'].length =
		0;
	Object.defineProperty(declared.refined, '~refine', { value: [] });

	const status = kv.fields.get('status');
	expect(status?.check('archived')).toBe(false);
	expect(status?.metadata).toEqual({
		kind: 'select',
		nullable: false,
		options: ['draft', 'published'],
	});
	expect(kv.fields.get('payload')?.check({ a: 'x' })).toBe(true);
	expect(kv.fields.get('payload')?.check({ a: 1 })).toBe(false);
	expect(kv.fields.get('refined')?.check('ab')).toBe(true);
	expect(kv.fields.get('refined')?.check('abc')).toBe(false);

	// Check and Errors read the same snapshot, so they agree.
	const bounded = kv.fields.get('bounded');
	expect(bounded?.check('abcde')).toBe(false);
	expect(bounded?.errors('abcde')).toEqual(['must be at most 4 UTF-8 bytes']);
	expect(bounded?.check('abcd')).toBe(true);
	expect(bounded?.errors('abcd')).toEqual([]);

	for (const [name, each] of kv.fields) {
		expect(each.schema).not.toBe(declared[name as keyof typeof declared]);
		expect(Object.isFrozen(each.schema)).toBe(true);
		expect(Object.isFrozen(each.metadata)).toBe(true);
		expect(() => {
			(each.schema as { maxLength?: number }).maxLength = 0;
		}).toThrow();
	}
	const refinements = (
		bounded?.schema as unknown as { '~refine': { refine: unknown }[] }
	)['~refine'];
	expect(Object.isFrozen(refinements)).toBe(true);
	expect(Object.isFrozen(refinements[0])).toBe(true);
	// A function is copied by reference and left alone.
	expect(Object.isFrozen(refinements[0]?.refine)).toBe(false);
	expect(
		Object.isFrozen(
			(kv.fields.get('status')?.schema as unknown as { enum: string[] }).enum,
		),
	).toBe(true);
});

test('undefined annotations do not stop freezing a compiled snapshot', () => {
	const declared = field.json(
		Type.Object({ a: Type.String() }, { description: undefined }),
	);
	const value = expectOk(compileKv({ value: declared })).kv.fields.get('value');
	const schema = value?.schema as unknown as {
		then: { properties: { a: { minLength?: number } } };
		if: object;
	};
	expect(Object.isFrozen(schema.then.properties)).toBe(true);
	expect(Object.isFrozen(schema.then.properties.a)).toBe(true);
	expect(Object.isFrozen(schema.if)).toBe(true);
	expect(() => {
		schema.then.properties.a.minLength = 10;
	}).toThrow();
	expect(value?.check({ a: 'x' })).toBe(true);
	expect(value?.errors({ a: 'x' })).toEqual([]);
});

test('a schema TypeBox cannot compile names its table and field', () => {
	const error = expectErr(
		compileKv({ title: field.json({ type: 'string', pattern: '[' }) }),
	);
	expect(error).toMatchObject({
		name: 'UnrecognizedField',
		table: 'kv',
		field: 'title',
	});
	expect(error.message).toContain('regular expression');
});

test('inherited or accessor metadata does not pass the declaration boundary', () => {
	const base = field.string();
	const accessor = field.string();
	Object.defineProperty(accessor, 'x-field', { get: () => base['x-field'] });
	for (const value of [Object.create(base), accessor]) {
		expect(expectErr(compileKv({ value })).name).toBe('UnrecognizedField');
	}
	// A wrapper must not restore provenance to a copy that already lost it.
	expect(() => field.nullable({ ...base })).toThrow('built with field.*');
});
