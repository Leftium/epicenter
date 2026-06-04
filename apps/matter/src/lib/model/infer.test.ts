import { describe, expect, test } from 'bun:test';
import {
	inferColumnKind,
	inferColumns,
	inferValueKind,
	isIsoDateString,
	isUrl,
} from './infer';
import type { Row } from './types';

describe('inferValueKind', () => {
	test('classifies scalars most-specific first', () => {
		expect(inferValueKind(true)).toBe('boolean');
		expect(inferValueKind(42)).toBe('integer');
		expect(inferValueKind(12.4)).toBe('number');
		expect(inferValueKind('2026-06-04')).toBe('datetime');
		expect(inferValueKind('2026-06-04T10:30:00Z')).toBe('datetime');
		expect(inferValueKind('https://example.com')).toBe('url');
		expect(inferValueKind('just text')).toBe('string');
	});

	test('a non-http URL-ish string is plain text', () => {
		expect(inferValueKind('mailto:x@y.com')).toBe('string');
		expect(isUrl('ftp://x')).toBe(false);
	});

	test('a date-shaped but invalid string is not datetime', () => {
		expect(isIsoDateString('2026-13-99')).toBe(false);
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
	test('all ISO dates -> datetime', () => {
		expect(inferColumnKind(['2026-01-02', '2026-03-04'])).toBe('datetime');
	});
	test('nulls are ignored; empty column -> string', () => {
		expect(inferColumnKind([null, undefined])).toBe('string');
		expect(inferColumnKind([null, 5, undefined])).toBe('integer');
	});
});

describe('inferColumns', () => {
	const rows: Row[] = [
		{ path: 'a.md', frontmatter: { title: 'A', status: 'draft', rating: 5 }, body: '' },
		{ path: 'b.md', frontmatter: { title: 'B', status: 'published' }, body: '' },
		{ path: 'c.md', frontmatter: { title: 'C', status: 'draft', rating: 3 }, body: '' },
	];

	test('orders by frequency then first-seen, and infers each kind', () => {
		expect(inferColumns(rows)).toEqual([
			{ key: 'title', kind: 'string', count: 3 },
			{ key: 'status', kind: 'string', count: 3 },
			{ key: 'rating', kind: 'integer', count: 2 },
		]);
	});

	test('is deterministic regardless of row order', () => {
		const reversed = [...rows].reverse();
		expect(inferColumns(reversed)).toEqual(inferColumns(rows));
	});
});
