/**
 * Portable definition export tests.
 * Verifies constraint and editor fidelity, deterministic discovery JSON,
 * and refusal of schemas that JSON serialization would weaken.
 */
import { expect, test } from 'bun:test';
import { Type } from 'typebox';
import { Format } from 'typebox/format';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	accepts,
	defineTable,
	exportSchema,
	field,
	prepareData,
	prepareSchema,
} from './index.js';

test('exports the prepared snapshot, portable constraints and hints without identity', () => {
	const hidden = Type.String();
	Object.defineProperty(hidden, 'minLength', { value: 3, enumerable: false });
	const declaration = {
		id: 'so.epicenter.export',
		title: 'Portable',
		kv: { status: field.select(['draft', 'ready']), hidden },
		tables: {
			notes: defineTable({
				fields: {
					meta: Type.Object(
						{
							count: Type.Integer({ minimum: 2 }),
							extra: Type.Optional(Type.String()),
						},
						{ additionalProperties: false },
					),
					literal: { const: { '~kind': 'user data' } },
					title: field.string({ minLength: 1, maxLength: 12 }),
				},
			}),
		},
	};
	const prepared = expectOk(prepareData(declaration));
	declaration.kv.status.enum.push('draft');
	const text = expectOk(exportSchema(prepared));
	const parsed = JSON.parse(text);
	expect(parsed.id).toBeUndefined();
	expect(parsed.title).toBe('Portable');
	expect(parsed.kv.status.enum).toEqual(['draft', 'ready']);
	expect(parsed.kv.status['x-field']).toEqual({ kind: 'select' });
	expect(parsed.kv.hidden.minLength).toBe(3);
	expect(parsed.tables.notes.fields.literal.const).toEqual({
		'~kind': 'user data',
	});
	expect(text.endsWith('\n')).toBe(true);
	const restored = expectOk(prepareSchema(parsed));
	for (const value of ['', 'ab', 'abc'])
		expect(accepts(restored.kv.hidden, value)).toBe(
			accepts(prepared.kv.hidden, value),
		);
	for (const value of [{ count: 2 }, { count: 1 }, { count: 2, unknown: true }])
		expect(accepts(restored.tables.notes.fields.meta, value)).toBe(
			accepts(prepared.tables.notes.fields.meta, value),
		);
});

test('identical declarations give stable bytes while field and array order are preserved', () => {
	const declaration = () => ({
		kv: { z: Type.String(), a: Type.Enum(['z', 'a']) },
		tables: {},
	});
	const first = expectOk(prepareSchema(declaration()));
	const second = expectOk(prepareSchema(declaration()));
	const text = expectOk(exportSchema(first));
	expect(text).toBe(expectOk(exportSchema(second)));
	expect(Object.keys(JSON.parse(text).kv)).toEqual(['z', 'a']);
	expect(JSON.parse(text).kv.a.enum).toEqual(['z', 'a']);
});

test('refinements, codecs, guards, and non-JSON pattern objects prevent export', () => {
	let invoked = 0;
	const schemas = [
		Type.Object({
			nested: Type.Refine(Type.String(), () => {
				invoked++;
				return true;
			}),
		}),
		Type.Codec(Type.String())
			.Decode((value) => value)
			.Encode((value) => value),
		{ '~guard': { check: () => true, errors: () => [] } },
		Type.String({ pattern: /abc/i }),
	];
	for (const schema of schemas) {
		const prepared = expectOk(
			prepareSchema({ kv: { value: schema }, tables: {} }),
		);
		expect(expectErr(exportSchema(prepared)).name).toBe('Unsupported');
	}
	expect(invoked).toBe(0);
});

test('removing an author-owned guard cannot weaken exported validation', () => {
	const guarded: Record<string, unknown> = {
		'~guard': { check: () => true, errors: () => [] },
	};
	const prepared = expectOk(
		prepareSchema({ kv: { value: guarded }, tables: {} }),
	);
	delete guarded['~guard'];
	expect(expectErr(exportSchema(prepared)).name).toBe('Unsupported');
});

test('unsafe annotations and body conversions are refused without running toJSON', () => {
	let invoked = 0;
	for (const annotation of [
		undefined,
		Infinity,
		{
			toJSON: () => {
				invoked++;
				return {};
			},
		},
	]) {
		const prepared = expectOk(
			prepareSchema({
				kv: { value: Type.String({ default: annotation }) },
				tables: {},
			}),
		);
		expect(expectErr(exportSchema(prepared)).name).toBe('Unsupported');
	}
	const prepared = expectOk(
		prepareSchema({
			kv: {},
			tables: {
				notes: defineTable({
					fields: {},
					body: { encode: () => '', decode: () => null },
				}),
			},
		}),
	);
	expect(expectErr(exportSchema(prepared)).name).toBe('Unsupported');
	expect(invoked).toBe(0);
});

test('raw declarations are refused before a getter can run', () => {
	let invoked = 0;
	const raw = {
		get title() {
			invoked++;
			return 'Unsafe';
		},
		kv: {},
		tables: {},
	};
	expect(expectErr(exportSchema(raw)).name).toBe('Unsupported');
	expect(invoked).toBe(0);
});

test('custom and replaced stock format callbacks prevent export', () => {
	try {
		Format.Set('local-code', (value) => value === 'yes');
		Format.Set('date', () => true);
		for (const format of ['local-code', 'date']) {
			const prepared = expectOk(
				prepareSchema({ kv: { value: Type.String({ format }) }, tables: {} }),
			);
			expect(expectErr(exportSchema(prepared)).name).toBe('Unsupported');
		}
	} finally {
		Format.Reset();
	}
	const prepared = expectOk(
		prepareSchema({ kv: { value: field.date() }, tables: {} }),
	);
	expect(expectOk(exportSchema(prepared))).toContain('"format": "date"');
});

for (const [keyword, name, constraint, value] of [
	['properties', 'count', { type: 'integer' }, { count: 'text' }],
	['patternProperties', '^count$', { type: 'integer' }, { count: 'text' }],
	['dependencies', 'count', ['other'], { count: 1 }],
	['dependentSchemas', 'count', { required: ['other'] }, { count: 1 }],
	['dependentRequired', 'count', ['other'], { count: 1 }],
] as const) {
	test(`hidden ${keyword} entries refuse export rather than changing validation`, () => {
		const map = {};
		Object.defineProperty(map, name, { value: constraint, enumerable: false });
		const prepared = expectOk(
			prepareSchema({
				kv: { value: { type: 'object', [keyword]: map } },
				tables: {},
			}),
		);
		expect(accepts(prepared.kv.value, value)).toBe(true);
		expect(expectErr(exportSchema(prepared)).cause).toBeInstanceOf(Error);
	});
}

test('fields and nested properties named properties remain portable', () => {
	const prepared = expectOk(
		prepareSchema({
			kv: { properties: Type.Any(), patternProperties: field.string() },
			tables: {
				notes: defineTable({
					fields: {
						properties: Type.Object({ properties: Type.String() }),
					},
				}),
			},
		}),
	);
	const restored = expectOk(
		prepareSchema(JSON.parse(expectOk(exportSchema(prepared)))),
	);
	expect(accepts(restored.kv.properties, { properties: 'text' })).toBe(true);
	expect(accepts(restored.kv.patternProperties, 'text')).toBe(true);
	expect(
		accepts(restored.tables.notes.fields.properties, { properties: 'text' }),
	).toBe(true);
	expect(
		accepts(restored.tables.notes.fields.properties, { properties: 1 }),
	).toBe(false);
});

test('a hidden map entry named ~kind still refuses export', () => {
	const properties = {};
	Object.defineProperty(properties, '~kind', {
		value: { type: 'integer' },
		enumerable: false,
	});
	const prepared = expectOk(
		prepareSchema({ kv: { value: { properties } }, tables: {} }),
	);
	expect(accepts(prepared.kv.value, { '~kind': 'text' })).toBe(true);
	expect(expectErr(exportSchema(prepared)).name).toBe('Unsupported');
});

test('a reference that gives a property map a schema role still refuses hidden constraints', () => {
	const hidden = {};
	Object.defineProperty(hidden, 'count', {
		value: { type: 'integer' },
		enumerable: false,
	});
	const prepared = expectOk(
		prepareSchema({
			kv: {
				value: { $ref: '#/properties', properties: { properties: hidden } },
			},
			tables: {},
		}),
	);
	expect(accepts(prepared.kv.value, { count: 'text' })).toBe(true);
	expect(expectErr(exportSchema(prepared)).name).toBe('Unsupported');
});

test('hidden definitions and literal object members preserve their all-own-name semantics', () => {
	const definitions = {};
	Object.defineProperty(definitions, 'value', {
		value: { const: 'yes' },
		enumerable: false,
	});
	const literal = {};
	Object.defineProperty(literal, 'hidden', { value: 1, enumerable: false });
	const prepared = expectOk(
		prepareSchema({
			kv: {
				reference: { $defs: definitions, $ref: '#/$defs/value' },
				literal: { const: literal },
			},
			tables: {},
		}),
	);
	const restored = expectOk(
		prepareSchema(JSON.parse(expectOk(exportSchema(prepared)))),
	);
	for (const value of ['yes', 'no'])
		expect(accepts(restored.kv.reference, value)).toBe(
			accepts(prepared.kv.reference, value),
		);
	for (const value of [{ hidden: 1 }, {}])
		expect(accepts(restored.kv.literal, value)).toBe(
			accepts(prepared.kv.literal, value),
		);
});

test('named and recursive references export without repeating the traversal forever', () => {
	const prepared = expectOk(
		prepareSchema({
			kv: {
				named: Type.Cyclic(
					{
						Node: Type.Object({
							label: Type.String(),
							children: Type.Array(Type.Ref('Node')),
						}),
					},
					'Node',
				),
				recursive: {
					$id: 'recursive',
					$recursiveAnchor: true,
					type: 'object',
					required: ['label'],
					properties: {
						label: { type: 'string' },
						child: { $recursiveRef: '#' },
					},
				},
			},
			tables: {},
		}),
	);
	const restored = expectOk(
		prepareSchema(JSON.parse(expectOk(exportSchema(prepared)))),
	);
	for (const value of [
		{ label: 'root', children: [{ label: 'child', children: [] }] },
		{ label: 'root', children: [{ label: 1, children: [] }] },
	])
		expect(accepts(restored.kv.named, value)).toBe(
			accepts(prepared.kv.named, value),
		);
	for (const value of [
		{ label: 'root', child: { label: 'child' } },
		{ label: 'root', child: { label: 1 } },
	])
		expect(accepts(restored.kv.recursive, value)).toBe(
			accepts(prepared.kv.recursive, value),
		);
});

test('local references use the nearest nested id scope, including annotation targets', () => {
	const hidden = {};
	Object.defineProperty(hidden, 'count', {
		value: { type: 'integer' },
		enumerable: false,
	});
	for (const target of [
		{ type: 'integer', minimum: 2 },
		{ properties: hidden },
	]) {
		const prepared = expectOk(
			prepareSchema({
				kv: {
					value: {
						type: 'object',
						required: ['nested'],
						default: { type: 'string' },
						properties: {
							nested: { $id: 'nested', default: target, $ref: '#/default' },
						},
					},
				},
				tables: {},
			}),
		);
		if ('properties' in target) {
			expect(accepts(prepared.kv.value, { nested: { count: 'text' } })).toBe(
				true,
			);
			expect(expectErr(exportSchema(prepared)).name).toBe('Unsupported');
		} else {
			const restored = expectOk(
				prepareSchema(JSON.parse(expectOk(exportSchema(prepared)))),
			);
			expect(accepts(restored.kv.value, { nested: 3 })).toBe(true);
			expect(accepts(restored.kv.value, { nested: 'text' })).toBe(false);
		}
	}
});

test('a nested recursive reference follows the first recursive anchor', () => {
	const hidden = {};
	Object.defineProperty(hidden, 'count', {
		value: { type: 'integer' },
		enumerable: false,
	});
	const prepared = expectOk(
		prepareSchema({
			kv: {
				value: {
					$id: 'outer',
					$recursiveAnchor: true,
					default: { properties: hidden },
					properties: {
						nested: {
							$id: 'inner',
							$recursiveAnchor: true,
							default: { type: 'string' },
							$recursiveRef: '#/default',
						},
					},
				},
			},
			tables: {},
		}),
	);
	expect(accepts(prepared.kv.value, { nested: { count: 'text' } })).toBe(true);
	expect(expectErr(exportSchema(prepared)).name).toBe('Unsupported');
});

test('hidden reference-target keywords cannot change compiled validator cache identity', () => {
	for (const reversed of [false, true]) {
		const loose = { type: 'string' };
		const strict = Object.defineProperty({ type: 'string' }, 'minLength', {
			value: 3,
		});
		const a = { $ref: '#/$defs/loose' };
		const b = { $ref: '#/$defs/strict' };
		const prepared = expectOk(
			prepareSchema({
				kv: {
					value: {
						type: 'object',
						required: ['a', 'b'],
						properties: reversed ? { b, a } : { a, b },
						$defs: { loose, strict },
					},
				},
				tables: {},
			}),
		);
		// The original cache collision is order-dependent. Neither answer can
		// be promised after making the hidden target keyword enumerable.
		expect(
			accepts(
				prepared.kv.value,
				reversed ? { a: 'xy', b: 'abc' } : { a: 'x', b: 'xy' },
			),
		).toBe(!reversed);
		expect(expectErr(exportSchema(prepared)).name).toBe('Unsupported');
	}
});

test('a hidden field-root keyword cannot collide with a referenced function', () => {
	const schema = { type: 'string' };
	Object.defineProperties(schema, {
		$defs: { value: { loose: { type: 'string' } } },
		$ref: { value: '#/$defs/loose' },
		minLength: { value: 3 },
	});
	const prepared = expectOk(
		prepareSchema({ kv: { value: schema }, tables: {} }),
	);
	expect(accepts(prepared.kv.value, 'abc')).toBe(false);
	expect(expectErr(exportSchema(prepared)).name).toBe('Unsupported');
});

test('a hidden referenced constraint exports when compiled function sharing stays the same', () => {
	const strict = Object.defineProperty({ type: 'string' }, 'minLength', {
		value: 3,
	});
	const schema = Object.defineProperty(
		{ $ref: '#/$defs/strict', $defs: { strict } },
		'maxLength',
		{ value: 5 },
	);
	const prepared = expectOk(
		prepareSchema({ kv: { value: schema }, tables: {} }),
	);
	const restored = expectOk(
		prepareSchema(JSON.parse(expectOk(exportSchema(prepared)))),
	);
	for (const value of ['xy', 'abc', 'abcdef'])
		expect(accepts(restored.kv.value, value)).toBe(
			accepts(prepared.kv.value, value),
		);
});

for (const change of ['marker', 'zero'] as const) {
	test(`${change} materialization cannot change cache sharing across reference scopes`, () => {
		const branch = (label: string) => {
			const target =
				change === 'marker'
					? { $recursiveRef: '#' }
					: { $recursiveRef: '#', default: label === 'a' ? -0 : 0 };
			if (change === 'marker')
				Object.defineProperty(target, '~kind', {
					value: label,
					enumerable: false,
				});
			return {
				$id: 'https://example.com/base',
				$recursiveAnchor: true,
				type: 'object',
				required: ['label'],
				properties: {
					label: { const: label },
					child: { $ref: '#/$defs/target' },
				},
				$defs: { target },
			};
		};
		const prepared = expectOk(
			prepareSchema({
				kv: {
					value: {
						type: 'object',
						required: ['a', 'b'],
						properties: { a: branch('a'), b: branch('b') },
					},
				},
				tables: {},
			}),
		);
		expect(
			accepts(prepared.kv.value, {
				a: { label: 'a', child: { label: 'a' } },
				b: { label: 'b', child: { label: 'b' } },
			}),
		).toBe(change === 'zero');
		expect(
			accepts(prepared.kv.value, {
				a: { label: 'a', child: { label: 'a' } },
				b: { label: 'b', child: { label: 'a' } },
			}),
		).toBe(change === 'marker');
		expect(expectErr(exportSchema(prepared)).name).toBe('Unsupported');
	});
}
