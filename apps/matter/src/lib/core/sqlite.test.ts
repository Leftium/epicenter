import { describe, expect, test } from 'bun:test';
import { classifyRows } from './conformance';
import { validateModel } from './model';
import { projectToSqlite } from './sqlite';
import type { Row } from './parse';

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

describe('schema script (DROP + CREATE, one execute_batch)', () => {
	test('drops then recreates: path PK, one NOT NULL column per field by storage class, _extra JSON', () => {
		const { schema } = projectToSqlite('drafts', m, []);
		expect(schema).toBe(
			'DROP TABLE IF EXISTS "drafts";\n' +
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
		const { schema } = projectToSqlite('my folder', weird, []);
		expect(schema).toContain('DROP TABLE IF EXISTS "my folder"');
		expect(schema).toContain('CREATE TABLE "my folder"');
		expect(schema).toContain('"a ""b""" TEXT NOT NULL');
	});
});

describe('insert template (one ? per column, bound positionally)', () => {
	test('lists every column in order with one placeholder each', () => {
		const { insert } = projectToSqlite('drafts', m, []);
		expect(insert).toBe(
			'INSERT INTO "drafts" (' +
				'"path", "title", "status", "count", "score", "live", "tags", "url", "_extra"' +
				') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
		);
		// path + 7 modeled fields + _extra = 9 placeholders.
		expect((insert.match(/\?/g) ?? []).length).toBe(9);
	});
});

describe('rows (valid only, serialized per storage class)', () => {
	const conformance = classifyRows(m.fields, [valid, incomplete]);
	const proj = projectToSqlite('drafts', m, conformance);

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
		const p = projectToSqlite('ranks', nm, classifyRows(nm.fields, [row]));
		expect(p.rows[0]).toEqual(['r.md', '2', '{}']); // select stored as TEXT, empty _extra
	});

	test('an all-invalid folder yields a schema but no rows', () => {
		const p = projectToSqlite('drafts', m, classifyRows(m.fields, [incomplete]));
		expect(p.rows).toEqual([]);
		expect(p.schema).toContain('CREATE TABLE "drafts"');
	});
});
