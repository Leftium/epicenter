import { describe, expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { type Kind, KINDS, META_BY_KIND, recognize } from './field';

/**
 * The discrimination invariant is the whole bet: every legal field schema must match
 * EXACTLY ONE meta. `countMatches` is the proof instrument; if it ever returns a
 * number other than 1 for a legal schema, the total `recognize` and the per-field
 * degrade both rest on sand.
 */
function countMatches(schema: unknown): number {
	return (Object.keys(META_BY_KIND) as Kind[]).filter((kind) =>
		Value.Check(META_BY_KIND[kind], schema),
	).length;
}

/** The kind `recognize` assigns, or null when the schema is outside the palette. */
const kindOf = (schema: unknown): Kind | null => recognize(schema)?.kind ?? null;

/** Canonical at-rest shape per kind: the minimal schema that should recognize as it. */
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
});

describe('recognize: every canonical schema matches exactly one meta', () => {
	for (const kind of KINDS) {
		test(`${kind} canonical matches exactly one meta and recognizes as ${kind}`, () => {
			const schema = CANONICAL[kind];
			expect(countMatches(schema)).toBe(1);
			expect(kindOf(schema)).toBe(kind);
		});
	}
});

describe('the cross-discrimination pairs (the shapes that could collide)', () => {
	test('bare string is string, not url/datetime/select', () => {
		expect(kindOf({ type: 'string' })).toBe('string');
		expect(countMatches({ type: 'string' })).toBe(1);
	});

	test('a uri-format string is url, not string', () => {
		const s = { type: 'string', format: 'uri' };
		expect(kindOf(s)).toBe('url');
		expect(Value.Check(META_BY_KIND.string, s)).toBe(false); // string forbids `format`
	});

	test('a date-time string is datetime, not string', () => {
		expect(kindOf({ type: 'string', format: 'date-time' })).toBe('datetime');
	});

	test('a string with enum is select, not string', () => {
		const s = { type: 'string', enum: ['a', 'b'] };
		expect(kindOf(s)).toBe('select');
		expect(Value.Check(META_BY_KIND.string, s)).toBe(false); // string forbids `enum`
	});

	test('select is base-agnostic: an integer enum is select, not integer', () => {
		const s = { type: 'integer', enum: [1, 2, 3] };
		expect(kindOf(s)).toBe('select');
		expect(Value.Check(META_BY_KIND.integer, s)).toBe(false); // integer forbids `enum`
		expect(countMatches(s)).toBe(1);
	});

	test('an enum with no type is select', () => {
		expect(kindOf({ enum: ['a', 'b'] })).toBe('select');
	});

	test('a string array is tags, not multiSelect', () => {
		const s = { type: 'array', items: { type: 'string' } };
		expect(kindOf(s)).toBe('tags');
		expect(Value.Check(META_BY_KIND.multiSelect, s)).toBe(false); // items lack `enum`
	});

	test('an enum-item array is multiSelect, not tags', () => {
		const s = { type: 'array', items: { type: 'string', enum: ['a', 'b'] } };
		expect(kindOf(s)).toBe('multiSelect');
		expect(Value.Check(META_BY_KIND.tags, s)).toBe(false); // string item forbids `enum`
	});

	test('an enum-item array with no item type is multiSelect', () => {
		expect(kindOf({ type: 'array', items: { enum: ['a', 'b'] } })).toBe(
			'multiSelect',
		);
	});
});

describe('refinements and annotations ride along without changing the kind', () => {
	test('string with minLength/pattern is still string', () => {
		const s = { type: 'string', minLength: 1, pattern: '^[a-z-]+$' };
		expect(kindOf(s)).toBe('string');
		expect(countMatches(s)).toBe(1);
	});

	test('a rating (integer with min/max) is still integer', () => {
		const s = { type: 'integer', minimum: 1, maximum: 5 };
		expect(kindOf(s)).toBe('integer');
		expect(countMatches(s)).toBe(1);
	});

	test('the annotation bucket (title/description/default) does not open the shape', () => {
		const s = {
			type: 'string',
			title: 'Headline',
			description: 'the H1',
			default: 'untitled',
		};
		expect(kindOf(s)).toBe('string');
		expect(countMatches(s)).toBe(1);
	});

	test('a default rides along on a select without tipping the kind', () => {
		const s = { type: 'string', enum: ['draft', 'published'], default: 'draft' };
		expect(kindOf(s)).toBe('select');
		expect(countMatches(s)).toBe(1);
	});

	test('tags with uniqueItems is still tags', () => {
		const s = { type: 'array', items: { type: 'string' }, uniqueItems: true };
		expect(kindOf(s)).toBe('tags');
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
		[
			'a number array (number[] is not curated)',
			{ type: 'array', items: { type: 'number' } },
		],
		['an object array', { type: 'array', items: { type: 'object' } }],
		[
			'a nullable wrapper (optionality is deleted)',
			{ anyOf: [{ type: 'string' }, { type: 'null' }] },
		],
		[
			'a true multi-branch union',
			{ anyOf: [{ type: 'string' }, { type: 'integer' }] },
		],
		[
			'an unrecognized format (email is not yet a kind)',
			{ type: 'string', format: 'email' },
		],
		// Annotations we deliberately did NOT admit: standard JSON Schema keywords with
		// no real authoring path into a Matter field. They degrade today; the day a real
		// schema carries one and degrades is the signal to add it to ANNOT, not before.
		['examples is not admitted', { type: 'string', examples: ['x'] }],
		['$comment is not admitted', { type: 'string', $comment: 'note' }],
		['deprecated is not admitted', { type: 'string', deprecated: true }],
		['an empty object', {}],
		['a non-object', 'string'],
		['null', null],
	];

	for (const [label, schema] of UNSUPPORTED) {
		test(`${label} matches no meta and recognizes as null`, () => {
			expect(countMatches(schema)).toBe(0);
			expect(recognize(schema)).toBeNull();
		});
	}
});
