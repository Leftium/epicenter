import { describe, expect, test } from 'bun:test';
import { buildFtsSearchSql, mapFtsSearchRows } from './fts.js';

describe('FTS search helpers', () => {
	test('buildFtsSearchSql builds the shared writer and reader query', () => {
		expect(buildFtsSearchSql('posts', 1)).toBe(
			'SELECT "posts"."id" AS id,\n' +
				'  snippet("posts_fts", 1, \'<mark>\', \'</mark>\', \'...\', 64) AS snippet,\n' +
				'  rank\n' +
				'FROM "posts_fts"\n' +
				'JOIN "posts" ON "posts".rowid = "posts_fts".rowid\n' +
				'WHERE "posts_fts" MATCH ?\n' +
				'ORDER BY rank LIMIT ?',
		);
	});

	test('mapFtsSearchRows normalizes SQLite result values', () => {
		expect(
			mapFtsSearchRows([
				{ id: 123, snippet: null, rank: '-1.5' },
				{ id: 'abc', snippet: '<mark>hit</mark>', rank: undefined },
			]),
		).toEqual([
			{ id: '123', snippet: '', rank: -1.5 },
			{ id: 'abc', snippet: '<mark>hit</mark>', rank: 0 },
		]);
	});
});
