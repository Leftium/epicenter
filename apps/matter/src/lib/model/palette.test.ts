import { describe, expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import {
	deriveKind,
	FieldSchema,
	isFieldSchema,
	type Kind,
	KINDS,
	META_BY_KIND,
	storageOf,
} from './palette';

/**
 * The discrimination invariant is the whole bet: every legal field schema must match
 * EXACTLY ONE meta. `countMatches` is the proof instrument; if it ever returns a
 * number other than 1 for a legal schema, the total `deriveKind` and the per-field
 * degrade both rest on sand.
 */
function countMatches(schema: unknown): number {
	return (Object.keys(META_BY_KIND) as Kind[]).filter((kind) =>
		Value.Check(META_BY_KIND[kind], schema),
	).length;
}

/** Canonical at-rest shape per kind: the minimal schema that should derive to it. */
const CANONICAL: Record<Kind, unknown> = {
	string: { type: 'string' },
	url: { type: 'string', format: 'uri' },
	datetime: { type: 'string', format: 'date-time' },
	select: { type: 'string', enum: ['draft', 'published'] },
	integer: { type: 'integer' },
	number: { type: 'number' },
	boolean: { type: 'boolean' },
	tags: { type: 'array', items: { type: 'string' } },
	multiSelect: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
};

describe('the palette catalog', () => {
	test('exactly the nine kinds, no json', () => {
		const expected: Kind[] = [
			'boolean',
			'datetime',
			'integer',
			'multiSelect',
			'number',
			'select',
			'string',
			'tags',
			'url',
		];
		expect([...KINDS].sort()).toEqual(expected.sort());
		expect(KINDS).not.toContain('json' as Kind);
	});

	test('storageOf maps every kind to its SQLite class', () => {
		expect(storageOf('string')).toBe('TEXT');
		expect(storageOf('url')).toBe('TEXT');
		expect(storageOf('datetime')).toBe('TEXT');
		expect(storageOf('select')).toBe('TEXT');
		expect(storageOf('tags')).toBe('TEXT');
		expect(storageOf('multiSelect')).toBe('TEXT');
		expect(storageOf('integer')).toBe('INTEGER');
		expect(storageOf('boolean')).toBe('INTEGER');
		expect(storageOf('number')).toBe('REAL');
	});
});

describe('discrimination: every canonical schema matches exactly one meta', () => {
	for (const kind of KINDS) {
		test(`${kind} canonical matches exactly one meta and derives to ${kind}`, () => {
			const schema = CANONICAL[kind];
			expect(countMatches(schema)).toBe(1);
			expect(isFieldSchema(schema)).toBe(true);
			expect(deriveKind(schema)).toBe(kind);
		});
	}
});

describe('the cross-discrimination pairs (the shapes that could collide)', () => {
	test('bare string is string, not url/datetime/select', () => {
		expect(deriveKind({ type: 'string' })).toBe('string');
		expect(countMatches({ type: 'string' })).toBe(1);
	});

	test('a uri-format string is url, not string', () => {
		const s = { type: 'string', format: 'uri' };
		expect(deriveKind(s)).toBe('url');
		expect(Value.Check(META_BY_KIND.string, s)).toBe(false); // string forbids `format`
	});

	test('a date-time string is datetime, not string', () => {
		expect(deriveKind({ type: 'string', format: 'date-time' })).toBe('datetime');
	});

	test('a string with enum is select, not string', () => {
		const s = { type: 'string', enum: ['a', 'b'] };
		expect(deriveKind(s)).toBe('select');
		expect(Value.Check(META_BY_KIND.string, s)).toBe(false); // string forbids `enum`
	});

	test('select is base-agnostic: an integer enum is select, not integer', () => {
		const s = { type: 'integer', enum: [1, 2, 3] };
		expect(deriveKind(s)).toBe('select');
		expect(Value.Check(META_BY_KIND.integer, s)).toBe(false); // integer forbids `enum`
		expect(countMatches(s)).toBe(1);
	});

	test('an enum with no type is select', () => {
		expect(deriveKind({ enum: ['a', 'b'] })).toBe('select');
	});

	test('a string array is tags, not multiSelect', () => {
		const s = { type: 'array', items: { type: 'string' } };
		expect(deriveKind(s)).toBe('tags');
		expect(Value.Check(META_BY_KIND.multiSelect, s)).toBe(false); // items lack `enum`
	});

	test('an enum-item array is multiSelect, not tags', () => {
		const s = { type: 'array', items: { type: 'string', enum: ['a', 'b'] } };
		expect(deriveKind(s)).toBe('multiSelect');
		expect(Value.Check(META_BY_KIND.tags, s)).toBe(false); // string item forbids `enum`
	});

	test('an enum-item array with no item type is multiSelect', () => {
		expect(deriveKind({ type: 'array', items: { enum: ['a', 'b'] } })).toBe(
			'multiSelect',
		);
	});
});

describe('refinements and annotations ride along without changing the kind', () => {
	test('string with minLength/pattern is still string', () => {
		const s = { type: 'string', minLength: 1, pattern: '^[a-z-]+$' };
		expect(deriveKind(s)).toBe('string');
		expect(countMatches(s)).toBe(1);
	});

	test('a rating (integer with min/max) is still integer', () => {
		const s = { type: 'integer', minimum: 1, maximum: 5 };
		expect(deriveKind(s)).toBe('integer');
		expect(countMatches(s)).toBe(1);
	});

	test('a title annotation does not open the shape', () => {
		const s = { type: 'string', title: 'Headline', description: 'the H1' };
		expect(deriveKind(s)).toBe('string');
		expect(countMatches(s)).toBe(1);
	});

	test('tags with uniqueItems is still tags', () => {
		const s = { type: 'array', items: { type: 'string' }, uniqueItems: true };
		expect(deriveKind(s)).toBe('tags');
		expect(countMatches(s)).toBe(1);
	});
});

describe('the rejection lane: unsupported shapes match no meta', () => {
	const UNSUPPORTED: Array<[string, unknown]> = [
		['a typo in the type', { type: 'strng' }],
		['a typo in a refinement key', { type: 'string', minLgth: 1 }],
		['an unknown extra key', { type: 'string', foo: 1 }],
		['a plain object', { type: 'object' }],
		['an object with properties', { type: 'object', properties: {} }],
		['a number array (number[] is not curated)', { type: 'array', items: { type: 'number' } }],
		['an object array', { type: 'array', items: { type: 'object' } }],
		[
			'a nullable wrapper (optionality is deleted)',
			{ anyOf: [{ type: 'string' }, { type: 'null' }] },
		],
		[
			'a true multi-branch union',
			{ anyOf: [{ type: 'string' }, { type: 'integer' }] },
		],
		['an unrecognized format (email is not yet a kind)', { type: 'string', format: 'email' }],
		['an empty object', {}],
		['a non-object', 'string'],
		['null', null],
	];

	for (const [label, schema] of UNSUPPORTED) {
		test(`${label} matches no meta and is not a field schema`, () => {
			expect(countMatches(schema)).toBe(0);
			expect(isFieldSchema(schema)).toBe(false);
			expect(() => deriveKind(schema)).toThrow();
		});
	}
});

describe('FieldSchema is the union of the metas (the boundary value)', () => {
	test('Value.Check against FieldSchema agrees with isFieldSchema', () => {
		for (const kind of KINDS) {
			expect(Value.Check(FieldSchema, CANONICAL[kind])).toBe(true);
		}
		expect(Value.Check(FieldSchema, { type: 'object' })).toBe(false);
		expect(Value.Check(FieldSchema, { anyOf: [{ type: 'string' }, { type: 'null' }] })).toBe(
			false,
		);
	});
});
