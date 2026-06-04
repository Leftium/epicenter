import { describe, expect, test } from 'bun:test';
import { classifyRow, classifyRows, compileColumns } from './conformance';
import { validateModel } from './model';
import type { Row } from './types';

function model(fields: Record<string, Record<string, unknown>>) {
	const { data, error } = validateModel({ fields });
	if (error) throw new Error(error.message);
	return data;
}

describe('classifyRow (per-cell conformance)', () => {
	const m = model({
		title: { type: 'string' },
		url: { anyOf: [{ type: 'string', format: 'uri' }, { type: 'null' }] },
		rating: { type: 'integer' },
	});
	const columns = compileColumns(m);

	test('a present valid value is OK; the row is valid when every cell is OK/EMPTY', () => {
		const row: Row = {
			name: 'a.md',
			frontmatter: { title: 'Hello', url: 'https://x.com', rating: 5 },
			body: '',
		};
		const c = classifyRow(columns, row);
		expect(c.cells.map((x) => x.state)).toEqual(['OK', 'OK', 'OK']);
		expect(c.rowValid).toBe(true);
	});

	test('a nullable field absent is EMPTY (valid); a required field absent is NEEDS_VALUE (invalid)', () => {
		const row: Row = { name: 'b.md', frontmatter: { title: 'Hi' }, body: '' };
		const c = classifyRow(columns, row);
		expect(c.cells.map((x) => x.state)).toEqual(['OK', 'EMPTY', 'NEEDS_VALUE']);
		expect(c.rowValid).toBe(false);
	});

	test('a present value failing its schema is INVALID', () => {
		const row: Row = {
			name: 'c.md',
			frontmatter: { title: 'Hi', url: 'not a url', rating: 'high' },
			body: '',
		};
		const c = classifyRow(columns, row);
		expect(c.cells.map((x) => x.state)).toEqual(['OK', 'INVALID', 'INVALID']);
		expect(c.rowValid).toBe(false);
	});

	// The tested nullish contract: a bare `title:` parses to null, an omitted
	// `title` is absent; both must classify identically.
	test('absent key and explicit null are the SAME empty', () => {
		const absent: Row = { name: 'd.md', frontmatter: {}, body: '' };
		const nul: Row = { name: 'e.md', frontmatter: { title: null }, body: '' };
		expect(classifyRow(columns, absent).cells[0]?.state).toBe('NEEDS_VALUE');
		expect(classifyRow(columns, nul).cells[0]?.state).toBe('NEEDS_VALUE');

		const m2 = model({ note: { anyOf: [{ type: 'string' }, { type: 'null' }] } });
		const cols2 = compileColumns(m2);
		const absent2: Row = { name: 'f.md', frontmatter: {}, body: '' };
		const nul2: Row = { name: 'g.md', frontmatter: { note: null }, body: '' };
		expect(classifyRow(cols2, absent2).cells[0]?.state).toBe('EMPTY');
		expect(classifyRow(cols2, nul2).cells[0]?.state).toBe('EMPTY');
	});

	test('extras are collected and never affect validity', () => {
		const row: Row = {
			name: 'h.md',
			frontmatter: { title: 'Hi', url: null, rating: 1, wild: 'extra', n: 9 },
			body: '',
		};
		const c = classifyRow(columns, row);
		expect(c.extras).toEqual([
			{ key: 'wild', value: 'extra' },
			{ key: 'n', value: 9 },
		]);
		expect(c.rowValid).toBe(true); // extras present, row still valid
	});
});

describe('classifyRows', () => {
	test('classifies every row against precompiled columns', () => {
		const m = model({ title: { type: 'string' } });
		const rows: Row[] = [
			{ name: 'a.md', frontmatter: { title: 'A' }, body: '' },
			{ name: 'b.md', frontmatter: {}, body: '' },
		];
		const conformance = classifyRows(compileColumns(m), rows);
		expect(conformance.map((c) => c.rowValid)).toEqual([true, false]);
	});
});
