import { describe, expect, test } from 'bun:test';
import { classifyRows } from './conformance';
import { validateModel } from './model';
import { projectToSqlite } from './sqlite';
import type { Row } from './types';

function model(fields: Record<string, Record<string, unknown>>) {
	const { data, error } = validateModel({ fields });
	if (error) throw new Error(error.message);
	return data;
}

const m = model({
	title: { type: 'string' },
	status: { type: 'string', enum: ['draft', 'published'] },
	count: { type: 'integer' },
	score: { type: 'number' },
	live: { type: 'boolean' },
	tags: { type: 'array', items: { type: 'string' } },
	url: { type: 'string', format: 'uri' },
});

const valid: Row = {
	name: 'post-1.md',
	frontmatter: {
		title: 'Hello',
		status: 'draft',
		count: 3,
		score: 4.5,
		live: true,
		tags: ['a', 'b'],
		url: 'https://x.com',
		extraKey: 'kept',
	},
	body: '',
};

const incomplete: Row = {
	name: 'post-2.md',
	frontmatter: { title: 'Partial' }, // missing required fields -> NEEDS_VALUE
	body: '',
};

describe('buildDdl', () => {
	test('path PK, one NOT NULL column per field with its storage class, _extra JSON', () => {
		const { ddl } = projectToSqlite('drafts', m, []);
		expect(ddl).toBe(
			'CREATE TABLE "drafts" (' +
				'"path" TEXT PRIMARY KEY, ' +
				'"title" TEXT NOT NULL, ' +
				'"status" TEXT NOT NULL, ' +
				'"count" INTEGER NOT NULL, ' +
				'"score" REAL NOT NULL, ' +
				'"live" INTEGER NOT NULL, ' +
				'"tags" TEXT NOT NULL, ' +
				'"url" TEXT NOT NULL, ' +
				'"_extra" TEXT NOT NULL)',
		);
	});

	test('identifiers with quotes/spaces are escaped', () => {
		const weird = model({ 'a "b"': { type: 'string' } });
		const { ddl } = projectToSqlite('my folder', weird, []);
		expect(ddl).toContain('CREATE TABLE "my folder"');
		expect(ddl).toContain('"a ""b""" TEXT NOT NULL');
	});
});

describe('drop and insert SQL (all SQL text built here, not in Rust)', () => {
	test('drop targets the quoted table', () => {
		const { drop } = projectToSqlite('drafts', m, []);
		expect(drop).toBe('DROP TABLE IF EXISTS "drafts"');
	});

	test('insert lists every column and one ? placeholder each', () => {
		const { insert, columns } = projectToSqlite('drafts', m, []);
		expect(insert).toBe(
			'INSERT INTO "drafts" (' +
				'"path", "title", "status", "count", "score", "live", "tags", "url", "_extra"' +
				') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
		);
		// one placeholder per column, so binding is positional against `columns`
		expect((insert.match(/\?/g) ?? []).length).toBe(columns.length);
	});
});

describe('projectToSqlite (valid rows only, serialized per storage class)', () => {
	const conformance = classifyRows(m.columns, [valid, incomplete]);
	const proj = projectToSqlite('drafts', m, conformance);

	test('columns are path, the modeled fields, then _extra', () => {
		expect(proj.columns).toEqual([
			'path',
			'title',
			'status',
			'count',
			'score',
			'live',
			'tags',
			'url',
			'_extra',
		]);
	});

	test('only the valid row projects; the incomplete one is absent', () => {
		expect(proj.rows).toHaveLength(1);
		expect(proj.rows[0]?.[0]).toBe('post-1.md');
	});

	test('each value is serialized to its storage class', () => {
		const [path, title, status, count, score, live, tags, url, extra] =
			proj.rows[0]!;
		expect(path).toBe('post-1.md');
		expect(title).toBe('Hello');
		expect(status).toBe('draft');
		expect(count).toBe(3); // INTEGER stays a number
		expect(score).toBe(4.5); // REAL stays a number
		expect(live).toBe(1); // boolean -> 0/1
		expect(tags).toBe('["a","b"]'); // array -> JSON TEXT
		expect(url).toBe('https://x.com');
		expect(extra).toBe('{"extraKey":"kept"}'); // unmodeled keys -> _extra JSON
	});

	test('a numeric enum select serializes to its TEXT form', () => {
		const nm = model({ rank: { type: 'integer', enum: [1, 2, 3] } });
		const row: Row = { name: 'r.md', frontmatter: { rank: 2 }, body: '' };
		const p = projectToSqlite('ranks', nm, classifyRows(nm.columns, [row]));
		expect(p.rows[0]).toEqual(['r.md', '2', '{}']); // select stored as TEXT, empty _extra
	});

	test('an all-invalid folder yields a table with no rows', () => {
		const p = projectToSqlite('drafts', m, classifyRows(m.columns, [incomplete]));
		expect(p.rows).toEqual([]);
		expect(p.ddl).toContain('CREATE TABLE "drafts"');
	});
});
