/**
 * Read Folder Tests
 *
 * `readFolder` reads a data folder on disk without opening it, through the
 * same tables, settings, and native file boundary an opened folder uses.
 *
 * Key behaviors:
 * - Every declared table is exactly what an opened folder's `list()` returns,
 *   and `kv` is exactly what its `kv.get()` returns
 * - A directory without `epicenter.json` is `NotDataFolder`; a declaration
 *   that is not UTF-8 JSON or declares nothing a folder can keep is
 *   `InvalidDeclaration`, as is an unknown top-level key or anything
 *   `exportSchema` refuses, such as an unknown format; a missing root is `NotFound`, a file root
 *   `NotADirectory`
 * - A symbolically linked table directory is that table's refusal, never
 *   followed, and the other tables still read
 * - It writes nothing: no Git repository, marker, lock, or declaration
 * - A data folder nested inside another repository reads like any other
 */
import { afterAll, expect, test } from 'bun:test';
import {
	mkdir,
	mkdtemp,
	readdir,
	rm,
	stat,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	DECLARATION_PATH,
	defineFolder,
	defineTable,
	field,
	openFolder,
	readFolder,
} from './bun.js';

const definition = defineFolder({
	kv: { theme: field.string() },
	tables: {
		todos: defineTable({ fields: { title: field.string() } }),
		notes: defineTable({ fields: { body: field.string() } }),
	},
});

const roots: string[] = [];
afterAll(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function scratch() {
	const root = await mkdtemp(join(tmpdir(), 'read-folder-'));
	roots.push(root);
	return root;
}

/** Every path under a directory, with its size, so a read can be shown to write nothing. */
async function tree(root: string): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await readdir(root, {
		recursive: true,
		withFileTypes: true,
	})) {
		const path = join(entry.parentPath, entry.name);
		const size = entry.isFile() ? (await stat(path)).size : 0;
		out.push(`${path.slice(root.length)}:${entry.isDirectory() ? 'd' : size}`);
	}
	return out.sort();
}

test('an opened folder reads back exactly as its tables and settings list it', async () => {
	const root = await scratch();
	const folder = expectOk(
		await openFolder({
			root,
			definition,
			git: { author: { name: 'T', email: 't@example.test' } },
		}),
	);
	expectOk(
		await folder.tables.todos.create(
			{ fields: { title: 'Milk' }, body: '' },
			{ stem: 'milk' },
		),
	);
	expectOk(
		await folder.files.create('todos/broken.md', '---\ntitle: [\n---\n'),
	);
	expectOk(await folder.kv.set('theme', 'dark'));
	const listed = expectOk(await folder.tables.todos.list());
	const kv = await folder.kv.get();
	await folder.close();

	const reading = expectOk(await readFolder(root));
	expect(Object.keys(reading.tables).sort()).toEqual(['notes', 'todos']);
	expect(expectOk(reading.tables.todos!)).toEqual(listed);
	expect(expectOk(reading.tables.notes!)).toEqual([]);
	expect(reading.kv).toEqual(kv);
	expect(Object.keys(reading.definition.tables).sort()).toEqual([
		'notes',
		'todos',
	]);
});

test('a directory without epicenter.json is NotDataFolder', async () => {
	const root = await scratch();
	expect(expectErr(await readFolder(root)).name).toBe('NotDataFolder');
});

test('a declaration that cannot be used is InvalidDeclaration', async () => {
	for (const text of [
		'{ not json',
		'null',
		'[]',
		'{"tables": {"t": {"fields": 3}}}',
	]) {
		const root = await scratch();
		await writeFile(join(root, DECLARATION_PATH), text);
		expect(expectErr(await readFolder(root))).toMatchObject({
			name: 'InvalidDeclaration',
		});
	}
});

test('an unknown top-level key is InvalidDeclaration, and $schema is allowed', async () => {
	const root = await scratch();
	const tables = { todos: { fields: { title: { type: 'string' } } } };
	await writeFile(
		join(root, DECLARATION_PATH),
		JSON.stringify({ kv: {}, tabels: tables }),
	);
	const refused = expectErr(await readFolder(root));
	expect(refused).toMatchObject({ name: 'InvalidDeclaration' });
	expect(refused.message).toContain("'tabels'");

	await writeFile(
		join(root, DECLARATION_PATH),
		JSON.stringify({ $schema: 'https://example.test/s.json', kv: {}, tables }),
	);
	expect(Object.keys(expectOk(await readFolder(root)).tables)).toEqual([
		'todos',
	]);
});

test('a declaration exportSchema refuses, such as an unknown format, is InvalidDeclaration', async () => {
	const root = await scratch();
	await writeFile(
		join(root, DECLARATION_PATH),
		JSON.stringify({
			kv: {},
			tables: {
				todos: {
					fields: { due: { type: 'string', format: 'date-tme' } },
				},
			},
		}),
	);
	const refused = expectErr(await readFolder(root));
	expect(refused).toMatchObject({ name: 'InvalidDeclaration' });
	expect(refused.message).toContain('tables.todos.fields.due.format');
	expect(refused.message).toContain('date-tme');
});

test('a missing root is NotFound and a file root is NotADirectory', async () => {
	const parent = await scratch();
	expect(expectErr(await readFolder(join(parent, 'missing')))).toMatchObject({
		name: 'NotFound',
		path: join(parent, 'missing'),
	});
	await writeFile(join(parent, 'file'), '');
	expect(expectErr(await readFolder(join(parent, 'file'))).name).toBe(
		'NotADirectory',
	);
});

test('an epicenter.json that is not a readable file is InvalidDeclaration', async () => {
	const root = await scratch();
	await mkdir(join(root, DECLARATION_PATH));
	expect(expectErr(await readFolder(root))).toMatchObject({
		name: 'InvalidDeclaration',
		root,
	});
});

test('a symbolically linked table directory is refused, not followed, and the other tables read', async () => {
	const root = await scratch();
	const elsewhere = await scratch();
	await writeFile(
		join(root, DECLARATION_PATH),
		JSON.stringify({
			kv: {},
			tables: {
				todos: { fields: { title: { type: 'string' } } },
				notes: { fields: { body: { type: 'string' } } },
			},
		}),
	);
	await mkdir(join(elsewhere, 'todos'));
	await writeFile(
		join(elsewhere, 'todos', 'a.md'),
		'---\ntitle: Outside\n---\n',
	);
	await symlink(join(elsewhere, 'todos'), join(root, 'todos'));
	await mkdir(join(root, 'notes'));
	await writeFile(join(root, 'notes', 'n.md'), '---\nbody: Inside\n---\n');

	const reading = expectOk(await readFolder(root));
	expect(expectErr(reading.tables.todos!).name).toBe('InvalidPath');
	expect(expectOk(reading.tables.notes!)).toHaveLength(1);
});

test('reading writes nothing, inside a folder nested in another repository', async () => {
	const repository = await scratch();
	await mkdir(join(repository, '.git'));
	const root = join(repository, 'data', 'todos-folder');
	await mkdir(join(root, 'todos'), { recursive: true });
	await writeFile(
		join(root, DECLARATION_PATH),
		JSON.stringify({
			kv: {},
			tables: { todos: { fields: { title: { type: 'string' } } } },
		}),
	);
	await writeFile(join(root, 'todos', 'a.md'), '---\ntitle: A\n---\n');
	const before = await tree(repository);

	const reading = expectOk(await readFolder(root));
	expect(expectOk(reading.tables.todos!)).toHaveLength(1);
	expect(expectOk(reading.kv)).toBeUndefined();
	expect(await tree(repository)).toEqual(before);
});
