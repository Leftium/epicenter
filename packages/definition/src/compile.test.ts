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
 *
 * See also:
 * - `packages/app/src/data/definition/compile.test.ts` for the same compiler
 *   bound to a Yjs body codec
 */
import { expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	compileData,
	type DataDefinition,
	defineTable,
	field,
} from './index.js';

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
