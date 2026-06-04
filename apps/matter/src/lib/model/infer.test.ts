import { describe, expect, test } from 'bun:test';
import { inferColumnKind, inferColumns, inferValueKind } from './infer';
import type { Row } from './types';

describe('inferValueKind', () => {
	test('classifies scalars most-specific first', () => {
		expect(inferValueKind(true)).toBe('boolean');
		expect(inferValueKind(42)).toBe('integer');
		expect(inferValueKind(12.4)).toBe('number');
		expect(inferValueKind('2026-06-04T10:30:00Z')).toBe('datetime');
		expect(inferValueKind('https://example.com')).toBe('url');
		expect(inferValueKind('just text')).toBe('string');
	});

	// The on-ramp invariant: inference must never claim `datetime` for a value
	// `column.dateTime` (full RFC 3339) would reject, or "Create model from
	// folder" marks its own rows invalid. A bare date, a space separator, a
	// missing offset, or no seconds all fall to `string`, the safe floor; only a
	// full instant is `datetime`.
	test('only a full RFC 3339 instant is datetime; everything looser is string', () => {
		expect(inferValueKind('2026-06-04T10:30:00Z')).toBe('datetime');
		expect(inferValueKind('2026-06-04T10:30:00+02:00')).toBe('datetime');
		expect(inferValueKind('2026-06-04')).toBe('string'); // bare date
		expect(inferValueKind('2026-06-04 10:30:00')).toBe('string'); // space, no zone
		expect(inferValueKind('2026-06-04T10:30:00')).toBe('string'); // no offset
		expect(inferValueKind('2026-06-04T10:30Z')).toBe('string'); // no seconds
	});

	// Increment 2 unified inference with the stored `column.url` schema
	// (`{ type:'string', format:'uri' }`). `format: uri` is full RFC 3986, so a
	// `mailto:` URI now infers as `url`, not `string`. This is NOT over-claiming:
	// the on-ramp invariant only forbids a kind whose schema would REJECT the
	// value, and the uri schema accepts mailto. Inference and conformance now
	// share one definition of "url".
	test('any RFC 3986 URI (incl. mailto) infers url under the unified schema', () => {
		expect(inferValueKind('mailto:x@y.com')).toBe('url');
		expect(inferValueKind('https://example.com')).toBe('url');
	});

	test('a date-shaped but invalid string is not datetime', () => {
		expect(inferValueKind('2026-13-99T00:00:00Z')).toBe('string');
	});
});

describe('inferColumnKind (the lattice)', () => {
	test('all integers -> integer', () => {
		expect(inferColumnKind([1, 2, 3])).toBe('integer');
	});
	test('integer + float -> number', () => {
		expect(inferColumnKind([1, 2.5])).toBe('number');
	});
	test('number + string -> string (permissive floor)', () => {
		expect(inferColumnKind([1, 'draft'])).toBe('string');
	});
	test('all booleans -> boolean', () => {
		expect(inferColumnKind([true, false])).toBe('boolean');
	});
	test('all full instants -> datetime', () => {
		expect(
			inferColumnKind(['2026-01-02T00:00:00Z', '2026-03-04T12:00:00Z']),
		).toBe('datetime');
	});
	test('bare dates -> string (column.dateTime would reject them)', () => {
		expect(inferColumnKind(['2026-01-02', '2026-03-04'])).toBe('string');
	});
	test('nulls are ignored; empty column -> string', () => {
		expect(inferColumnKind([null, undefined])).toBe('string');
		expect(inferColumnKind([null, 5, undefined])).toBe('integer');
	});
});

describe('inferColumns', () => {
	const rows: Row[] = [
		{ path: 'a.md', frontmatter: { title: 'A', status: 'draft', rating: 5, tags: ['x', 'y'] }, body: '' },
		{ path: 'b.md', frontmatter: { title: 'B', status: 'published' }, body: '' },
		{ path: 'c.md', frontmatter: { title: 'C', status: 'draft', rating: 3, tags: ['z'] }, body: '' },
	];

	test('orders by frequency then first-seen, infers kind and array', () => {
		expect(inferColumns(rows)).toEqual([
			{ key: 'title', kind: 'string', array: false, count: 3 },
			{ key: 'status', kind: 'string', array: false, count: 3 },
			{ key: 'rating', kind: 'integer', array: false, count: 2 },
			{ key: 'tags', kind: 'string', array: true, count: 2 },
		]);
	});

	test('an array column infers its element kind', () => {
		const r: Row[] = [{ path: 'a.md', frontmatter: { scores: [1, 2, 3] }, body: '' }];
		expect(inferColumns(r)).toEqual([{ key: 'scores', kind: 'integer', array: true, count: 1 }]);
	});

	test('a nested object falls back to string (rendered via the JSON cell)', () => {
		const r: Row[] = [{ path: 'a.md', frontmatter: { meta: { a: 1 } }, body: '' }];
		expect(inferColumns(r)).toEqual([{ key: 'meta', kind: 'string', array: false, count: 1 }]);
	});

	test('is deterministic regardless of row order', () => {
		const reversed = [...rows].reverse();
		expect(inferColumns(reversed)).toEqual(inferColumns(rows));
	});
});
