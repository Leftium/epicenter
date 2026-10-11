/**
 * App definition preparation tests.
 *
 * `defineStore` returns the prepared definition, in the shape it was declared
 * in, and an opened store reads through that same definition.
 *
 * Key behaviors:
 * - A prepared App definition keeps its Yjs body codec by reference and its
 *   fields as native schemas, hint included
 * - `defineStore` returns the prepared snapshot, not the author's objects, and
 *   preparing it again returns it
 * - An opened store's `definition` is that same prepared definition
 * - A schema reused in a second store after an edit reads apart from the first
 * - A malformed codec and a schema TypeBox cannot compile report errors
 * - A nullable field accepts an explicit null; a required row field must be
 *   present, and every KV field may be absent
 *
 * See also:
 * - `packages/definition/src/prepare.test.ts` for the shared preparation
 */
import { expect, test } from 'bun:test';
import { defineStore } from '@epicenter/app';
import { check, type FieldMap, fieldEditorOf } from '@epicenter/definition';
import { Type } from 'typebox';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openMemory } from '../store/memory.js';
import { plainText } from './body.js';
import { field } from './declaration.js';
import { defineTable } from './define.js';
import { prepareData } from './index.js';

/** Whether one prepared field admits a present value. */
const accepts = (schema: FieldMap[string] | undefined, value: unknown) =>
	schema !== undefined &&
	check({ value: schema }, { value }, 'patch').issues.length === 0;

const body = plainText();
const declared = {
	id: 'so.epicenter.data',
	kv: { name: field.string() },
	tables: {
		notes: defineTable({
			fields: {
				title: field.string(),
				folder: field.nullable(field.reference('folders')),
			},
			body,
		}),
	},
};
const database = defineStore(declared);

test('defineStore returns the prepared definition in the declared shape', () => {
	expect(Object.keys(database)).toEqual(['id', 'kv', 'tables']);
	expect(Object.keys(database.tables)).toEqual(['notes']);
	expect(Object.keys(database.tables.notes)).toEqual(['fields', 'body']);
	expect(Object.keys(database.tables.notes.fields)).toEqual([
		'title',
		'folder',
	]);
	// The codec is the author's, carried by reference and never frozen.
	expect(database.tables.notes.body).toBe(body);
	expect(Object.isFrozen(body)).toBe(false);
	// A field is the native schema, with the hint its helper set.
	expect(database.kv.name).toEqual(field.string());
	expect(database.tables.notes.fields.folder).toEqual(
		field.nullable(field.reference('folders')),
	);
	expect(fieldEditorOf(database.tables.notes.fields.folder)).toEqual({
		kind: 'reference',
		target: 'folders',
	});

	// It is the owned snapshot, not what the author wrote.
	expect(database.kv).not.toBe(declared.kv);
	expect(database.kv.name).not.toBe(declared.kv.name);
	expect(database.tables.notes).not.toBe(declared.tables.notes);
	for (const owned of [
		database,
		database.kv,
		database.kv.name,
		database.tables,
		database.tables.notes,
		database.tables.notes.fields,
		database.tables.notes.fields.title,
	])
		expect(Object.isFrozen(owned)).toBe(true);
	expect(Object.isFrozen(declared.kv)).toBe(false);
	expect(Object.isFrozen(declared.kv.name)).toBe(false);
	expect(() => {
		(database.kv as Record<string, unknown>).added = field.string();
	}).toThrow(TypeError);
});

test('a defined store is already prepared: preparing it again returns it', () => {
	const again = prepareData(database);
	expect(expectOk(again)).toBe(database);
	expect(prepareData(database)).toBe(again);
	// The declaration itself was never the memo key, so it is prepared anew.
	expect(expectOk(prepareData(declared))).not.toBe(database);
});

test('an opened store reads through the prepared definition it was defined with', async () => {
	await using data = await openMemory(database);
	expect(data.definition).toBe(database);
	expect(accepts(data.definition.kv.name, 'Honeycrisp')).toBe(true);
	expect(accepts(data.definition.kv.name, 7)).toBe(false);
	expect(data.definition.tables.notes?.fields.folder).toBe(
		database.tables.notes.fields.folder,
	);

	// A declaration nobody passed through `defineStore` is prepared at open,
	// and the store holds the snapshot, not the declaration.
	await using raw = await openMemory(declared);
	expect(raw.definition).not.toBe(declared);
	expect(raw.definition.kv.name).not.toBe(declared.kv.name);
	expect(Object.isFrozen(raw.definition.kv.name)).toBe(true);
	expect(raw.definition).toBe(expectOk(prepareData(declared)));
});

test('a schema edited and reused in a second store reads apart from the first', async () => {
	const theme = field.string({ maxLength: 4 });
	const first = defineStore({
		id: 'so.epicenter.first',
		kv: { theme },
		tables: {},
	});
	Object.assign(theme, { maxLength: 5 });
	const second = defineStore({
		id: 'so.epicenter.second',
		kv: { theme },
		tables: {},
	});
	expect(first.kv.theme).not.toBe(second.kv.theme);

	await using older = await openMemory(first);
	await using newer = await openMemory(second);
	// App writes check JSON and names only; the read is where the schema decides.
	older.kv.update({ theme: 'sepia' });
	newer.kv.update({ theme: 'sepia' });
	expect(older.kv.get('theme')).toBeUndefined();
	expect(older.kv.nonconforming.map(({ field }) => field)).toEqual(['theme']);
	expect(newer.kv.get('theme')).toBe('sepia');
	expect(newer.kv.nonconforming).toEqual([]);
});

test('a key the kv does not declare reads as absent, whatever its name', async () => {
	await using data = await openMemory(database);
	// The handle as an untyped caller reaches it, with keys the type refuses.
	const kv = data.kv as unknown as {
		get(key: string): unknown;
		update(values: Record<string, unknown>): void;
	};
	kv.update({ name: 'Honeycrisp', constructor: 'stored', extra: 1 });
	expect(kv.get('name')).toBe('Honeycrisp');
	for (const key of ['constructor', 'toString', '__proto__', 'extra'])
		expect(kv.get(key)).toBeUndefined();
	expect(data.kv.nonconforming).toEqual([]);
});

test('omitting a codec prepares only the declared fields', () => {
	const definition = defineStore({
		id: 'so.epicenter.fields-only',
		kv: {},
		tables: {
			queries: defineTable({
				fields: { name: field.string(), sql: field.string() },
			}),
		},
	});
	const table = definition.tables.queries;
	expect(Object.keys(table)).toEqual(['fields']);
	expect(Object.keys(table.fields)).toEqual(['name', 'sql']);
});

test('an explicitly malformed codec is refused at preparation', () => {
	for (const body of [
		null,
		{},
		{ encode: 'invalid', decode() {} },
		{ encode() {} },
	]) {
		const error = expectErr(
			prepareData({
				id: 'so.epicenter.invalid-codec',
				kv: {},
				tables: {
					notes: {
						fields: {},
						// @ts-expect-error exercise the runtime declaration boundary
						body,
					},
				},
			}),
		);
		expect(error.name).toBe('Malformed');
		expect(error.message).toContain('invalid body codec');
	}
});

test('a native schema no helper built is a field with the JSON editor', () => {
	for (const bare of [Type.String(), { type: 'string' }]) {
		const value = expectOk(
			prepareData({ id: 'test.native', tables: {}, kv: { value: bare } }),
		).kv.value;
		expect(fieldEditorOf(value)).toEqual({ kind: 'json' });
		expect(accepts(value, null)).toBe(false);
		expect(accepts(value, 'text')).toBe(true);
		expect(accepts(value, 1)).toBe(false);
	}
	const helper = expectOk(
		prepareData({
			id: 'test.helper',
			tables: {},
			kv: { value: field.nullable(field.reference('notes')) },
		}),
	).kv.value;
	expect(fieldEditorOf(helper)).toEqual({ kind: 'reference', target: 'notes' });
	expect(accepts(helper, null)).toBe(true);
});

test('a schema TypeBox cannot compile identifies the table and field', () => {
	const error = expectErr(
		prepareData({
			id: 'test.invalid-pattern',
			kv: {},
			tables: {
				notes: defineTable({
					fields: {
						title: field.json({ type: 'string', pattern: '[' }),
					},
				}),
			},
		}),
	);
	expect(error).toMatchObject({
		name: 'UnrecognizedField',
		table: 'notes',
		field: 'title',
	});
	expect(error.message).toContain('regular expression');
	expect(() =>
		defineStore({
			id: 'test.invalid-pattern',
			kv: { title: field.json({ type: 'string', pattern: '[' }) },
			tables: {},
		}),
	).toThrow('regular expression');
});

test('nullable fields accept explicit null; a row field must be present, a KV field need not be', () => {
	const { kv, tables } = expectOk(
		prepareData({
			id: 'test.nullable',
			kv: { title: field.nullable(field.string()) },
			tables: {
				notes: defineTable({
					fields: { title: field.nullable(field.string()) },
				}),
			},
		}),
	);
	expect(check(kv, { title: null }, 'read')).toEqual({
		conforming: { title: null },
		issues: [],
	});
	expect(check(kv, {}, 'read').issues).toEqual([]);
	expect(check(tables.notes.fields, {}, 'read').issues).toEqual([
		{ field: 'title', message: 'title is missing' },
	]);
});

test('trusted JSON fields keep TypeBox support for local schema references', () => {
	const { kv } = expectOk(
		prepareData({
			id: 'test.json-reference',
			kv: {
				value: field.json({
					$defs: { text: { type: 'string', minLength: 2 } },
					$ref: '#/$defs/text',
				}),
			},
			tables: {},
		}),
	);
	expect(check(kv, { value: 'yes' }, 'read').issues).toEqual([]);
	expect(check(kv, { value: 'x' }, 'read').issues).toHaveLength(1);
});
