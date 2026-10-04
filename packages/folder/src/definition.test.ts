/**
 * Folder Definition Tests
 *
 * `defineFolder` returns the prepared definition, in the shape it was declared
 * in, and a folder opened from it names each table by its key in that
 * definition and reads values through its schema snapshots.
 *
 * Key behaviors:
 * - `defineFolder` returns an owned, frozen definition of the declared shape,
 *   and preparing it again returns it
 * - A definition names no folder: an `id` is refused at the declaration and
 *   at the opener, and the opener's ID selects the dataset
 * - One prepared definition opens two folders that stay apart, and another
 *   definition reading one of them keeps the fields it does not declare
 * - A table name that every object inherits (`constructor`, `toString`) is an
 *   ordinary table: its handle and its directory
 * - One declared table under two names is two tables with two directories
 * - A schema edited after `defineFolder` does not change what the folder
 *   accepts, and a second definition reusing it reads the edit
 *
 * See also:
 * - `packages/definition/src/prepare.test.ts` for preparation itself
 * - `browser.test.ts` and `native.test.ts` for a refused body conversion
 */
import { afterAll, afterEach, expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openFolder } from './browser.js';
import {
	browserStorage,
	createTestStorage,
	locationOf,
	opfsOf,
	type TestStorage,
} from './browser-storage.test-support.js';
import { defineFolder, defineTable, field } from './contract.js';
import { prepareFolderDefinition } from './definition.js';
import { installWebLocks } from './web-locks.test-support.js';

afterAll(installWebLocks());

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0)) await close();
});

async function open<
	const TDefinition extends Parameters<typeof openFolder>[0]['definition'],
>(
	definition: TDefinition,
	{
		id = 'so.epicenter.definitiontest',
		storage = createTestStorage(),
	}: { id?: string; storage?: TestStorage } = {},
) {
	const folder = expectOk(
		await openFolder({
			id,
			definition,
			browser: {
				author: { name: 'Definition', email: 'definition@example.test' },
				commitOnEdit: false,
				...browserStorage(storage),
			},
		}),
	);
	closers.push(() => folder.close());
	return folder;
}

const paths = async (folder: Pick<Awaited<ReturnType<typeof open>>, 'files'>) =>
	expectOk(await folder.files.list()).files.map((file) => file.path);

test('defineFolder returns the prepared definition in the declared shape', () => {
	const declared = {
		title: 'Definition',
		kv: { theme: field.select(['light', 'dark']) },
		tables: {
			todos: defineTable({
				fields: { title: field.string(), done: field.boolean() },
			}),
		},
	};
	const definition = defineFolder(declared);

	expect(Object.keys(definition)).toEqual(['title', 'kv', 'tables']);
	expect(Object.keys(definition.tables)).toEqual(['todos']);
	expect(Object.keys(definition.tables.todos)).toEqual(['fields']);
	expect(Object.keys(definition.tables.todos.fields)).toEqual([
		'title',
		'done',
	]);
	// A field is the native schema, hint included, and a snapshot of it.
	expect(definition.kv.theme).toEqual(field.select(['light', 'dark']));
	expect(definition.kv.theme).not.toBe(declared.kv.theme);
	for (const owned of [
		definition,
		definition.kv,
		definition.kv.theme,
		definition.tables,
		definition.tables.todos,
		definition.tables.todos.fields,
	])
		expect(Object.isFrozen(owned)).toBe(true);
	expect(Object.isFrozen(declared.kv.theme)).toBe(false);

	// An opener handed this definition gets it back and prepares nothing.
	expect(expectOk(prepareFolderDefinition(definition))).toBe(definition);
	expect(expectOk(prepareFolderDefinition(declared))).not.toBe(definition);
	expect(
		expectErr(
			prepareFolderDefinition({ ...declared, kv: { id: field.string() } }),
		).reason,
	).toContain("field name 'kv.id' is not usable");
});

test('a definition names no folder: an id is refused where it is written and where it is opened', async () => {
	const declared = { kv: {}, tables: {} };
	expect(() =>
		defineFolder({ ...declared, id: 'so.epicenter.named' } as never),
	).toThrow('Pass the folder ID to openFolder');
	expect(
		expectErr(
			prepareFolderDefinition({
				...declared,
				id: 'so.epicenter.named',
			} as never),
		).reason,
	).toContain('declares an id');

	const storage = createTestStorage();
	const refused = expectErr(
		await openFolder({
			id: 'so.epicenter.named',
			definition: { ...declared, id: 'so.epicenter.named' } as never,
			browser: browserStorage(storage),
		}),
	);
	expect(refused.name).toBe('InvalidDefinition');
	expect(opfsOf(storage).directories()).toEqual([]);
});

test('one prepared definition opens two folders that stay apart, and another definition keeps what it does not declare', async () => {
	const definition = defineFolder({
		kv: { theme: field.string() },
		tables: {
			todos: defineTable({
				fields: { title: field.string(), done: field.boolean() },
			}),
		},
	});
	const storage = createTestStorage();
	const personal = await open(definition, {
		id: 'so.epicenter.todos',
		storage,
	});
	const work = await open(definition, {
		id: 'so.epicenter.todos.work',
		storage,
	});
	expect(personal.location).toEqual(locationOf('so.epicenter.todos'));
	expect(work.location).toEqual(locationOf('so.epicenter.todos.work'));

	const made = expectOk(
		await personal.tables.todos.create({
			stem: 'milk',
			fields: { title: 'Milk', done: false },
		}),
	);
	expectOk(await personal.kv.create({ theme: 'dark' }));
	expectOk(
		await work.tables.todos.create({
			stem: 'report',
			fields: { title: 'Report', done: false },
		}),
	);
	expect(await paths(personal)).toEqual(['kv.json', 'todos/milk.md']);
	expect(await paths(work)).toEqual(['todos/report.md']);
	expect(expectOk(await work.tables.todos.get('milk'))).toBeUndefined();
	expect(expectOk(await work.kv.get())).toBeUndefined();
	await personal.close();

	// Another tool reads the same folder through a narrower definition.
	const titles = defineFolder({
		kv: {},
		tables: { todos: defineTable({ fields: { title: field.string() } }) },
	});
	const reopened = await open(titles, { id: 'so.epicenter.todos', storage });
	expect(expectOk(await reopened.tables.todos.get('milk'))?.fields).toEqual({
		title: 'Milk',
	});
	const renamed = expectOk(
		await reopened.tables.todos.update('milk', {
			fields: { title: 'Oat milk' },
		}),
	);
	expect(renamed.source).toBe(made.source.replace('Milk', 'Oat milk'));
	expect(
		new TextDecoder().decode(
			expectOk(await reopened.files.read('kv.json')).bytes,
		),
	).toContain('"theme"');
});

test('tables named like Object.prototype members, and one table under two names, each keep their own directory', async () => {
	const row = defineTable({ fields: { title: field.string() } });
	const folder = await open(
		defineFolder({
			kv: { valueOf: field.string() },
			tables: { constructor: row, toString: row, notes: row },
		}),
	);
	expect(Object.keys(folder.tables)).toEqual([
		'constructor',
		'toString',
		'notes',
	]);

	const made = expectOk(
		await folder.tables.constructor.create({
			stem: 'a',
			fields: { title: 'Made' },
		}),
	);
	expect(made.path).toBe('constructor/a.md');
	expectOk(
		await folder.tables.toString.create({
			stem: 'b',
			fields: { title: 'Text' },
		}),
	);
	expectOk(
		await folder.tables.notes.create({ stem: 'b', fields: { title: 'Note' } }),
	);
	expect((await paths(folder)).sort()).toEqual([
		'constructor/a.md',
		'notes/b.md',
		'toString/b.md',
	]);
	// The same stem in two tables is two rows, each read by its own table.
	expect(expectOk(await folder.tables.toString.get('b'))?.fields).toEqual({
		title: 'Text',
	});
	expect(expectOk(await folder.tables.notes.get('b'))?.fields).toEqual({
		title: 'Note',
	});
	expect(expectOk(await folder.tables.constructor.get('b'))).toBeUndefined();
	expect(
		expectOk(await folder.tables.constructor.list()).map((entry) => entry.path),
	).toEqual(['constructor/a.md']);
	// Each name checks its own rows.
	const refused = expectErr(
		await folder.tables.toString.create({
			stem: 'c',
			fields: { title: 7 as never },
		}),
	);
	expect(refused.name).toBe('InvalidValues');

	expectOk(await folder.kv.create({ valueOf: 'stored' }));
	expect(expectOk(await folder.kv.get())?.values).toEqual({
		valueOf: 'stored',
	});
});

test('a schema edited after defineFolder changes nothing the folder accepts, and a later definition reads the edit', async () => {
	const title = field.string({ maxLength: 4 });
	const table = defineTable({ fields: { title } });
	const first = defineFolder({
		kv: {},
		tables: { todos: table },
	});
	// The author still holds an ordinary mutable schema, and declares it again.
	Object.assign(title, { maxLength: 9 });
	const second = defineFolder({
		kv: {},
		tables: { todos: table },
	});
	expect(first.tables.todos.fields.title).not.toBe(
		second.tables.todos.fields.title,
	);

	const older = await open(first);
	const newer = await open(second);
	const fields = { title: 'Longer' };
	expect(
		expectErr(await older.tables.todos.create({ stem: 'a', fields })).name,
	).toBe('InvalidValues');
	expect(
		expectOk(await newer.tables.todos.create({ stem: 'a', fields })).fields,
	).toEqual(fields);
	expect(
		older.tables.todos.inspect('---\ntitle: Longer\n---\n').issues,
	).toHaveLength(1);
	expect(
		newer.tables.todos.inspect('---\ntitle: Longer\n---\n').issues,
	).toEqual([]);
});
