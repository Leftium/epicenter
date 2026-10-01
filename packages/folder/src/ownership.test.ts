/**
 * Byte Ownership, Row Files, and Directory Tests
 *
 * Counterexamples at the folder's file boundary: bytes must be the caller's
 * bytes at call time, table operations must touch only the literal row file,
 * and empty directories must behave as directories.
 *
 * Key behaviors:
 * - Every content verb copies the caller's array before any await, so saved
 *   bytes and the returned capture match what was passed
 * - Rename and delete change exactly one Markdown file, whatever same-stem
 *   siblings appeared, changed, or multiplied after the entry was captured
 * - A stem is one literal segment; `todos/a/b.md` is not a row, while an
 *   externally written row with an invalid stem stays listable
 * - An empty directory lists, removes, and works from the terminal
 *
 * See also:
 * - `browser.test.ts` for table CRUD and history
 * - `files.test.ts` for captures and the file verbs
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { expectOk } from 'wellcrafted/testing';
import {
	defineFolder,
	defineTable,
	type Folder,
	field,
	openFolder,
} from './browser.js';
import { captureVersion } from './version.js';

const definition = defineFolder({
	id: 'so.epicenter.todostest',
	kv: {},
	tables: {
		todos: defineTable({
			fields: { title: field.string(), done: field.boolean() },
		}),
	},
});
const opened: Folder<typeof definition>[] = [];
const encoder = new TextEncoder();

async function open() {
	const folder = expectOk(
		await openFolder({
			id: 'ownership',
			definition,
			browser: {
				author: { name: 'Owner', email: 'owner@example.test' },
				commitOnEdit: false,
				indexedDb: { indexedDB: new IDBFactory(), IDBKeyRange },
			},
		}),
	);
	opened.push(folder);
	return folder;
}

afterEach(async () => {
	for (const folder of opened.splice(0)) await folder.close();
});

describe('byte ownership', () => {
	test('create, replace, and overwrite each own their bytes before the caller can mutate them', async () => {
		const folder = await open();
		const first = await captureVersion(encoder.encode('AAAA'));

		const content = encoder.encode('AAAA');
		const creating = folder.files.create('bytes.txt', content);
		content.set(encoder.encode('BBBB'));
		const created = expectOk(await creating);
		expect(created).toEqual({ path: 'bytes.txt', version: first });
		const read = expectOk(await folder.files.read('bytes.txt'));
		expect(new TextDecoder().decode(read.bytes)).toBe('AAAA');
		expect(read.version).toEqual(first);

		const next = encoder.encode('CCCC');
		const replacing = folder.files.replace(created, next);
		next.set(encoder.encode('DDDD'));
		const replaced = expectOk(await replacing);
		expect(replaced.version).toEqual(
			await captureVersion(encoder.encode('CCCC')),
		);

		const last = encoder.encode('EEEE');
		const overwriting = folder.files.overwrite('bytes.txt', last);
		last.set(encoder.encode('FFFF'));
		const overwritten = expectOk(await overwriting);
		expect(overwritten.version).toEqual(
			await captureVersion(encoder.encode('EEEE')),
		);
		expect(
			new TextDecoder().decode(
				expectOk(await folder.files.read('bytes.txt')).bytes,
			),
		).toBe('EEEE');
	});

	test('a view over a larger buffer saves only the view, and a Node Buffer is copied, not aliased', async () => {
		const folder = await open();
		const backing = encoder.encode('--middle--');
		const view = backing.subarray(2, 8);
		const saving = folder.files.create('view.txt', view);
		backing.fill(0x21);
		expect(expectOk(await saving).version).toEqual(
			await captureVersion(encoder.encode('middle')),
		);

		const buffer = Buffer.from('buffer bytes');
		const buffered = folder.files.create('buffer.txt', buffer);
		buffer.fill(0);
		expectOk(await buffered);
		expect(
			new TextDecoder().decode(
				expectOk(await folder.files.read('buffer.txt')).bytes,
			),
		).toBe('buffer bytes');
	});
});

describe('row files', () => {
	test('rename and delete touch one Markdown file while siblings appear, change, and multiply', async () => {
		const folder = await open();
		const plain = expectOk(
			await folder.tables.todos.create({
				stem: 'plain',
				fields: { title: 'Plain', done: false },
			}),
		);
		// Siblings arrive after the entry was captured. None of them is the row.
		const late = expectOk(
			await folder.files.create('todos/plain.opus', 'late'),
		);
		expectOk(await folder.files.create('todos/plain.flac', 'x'));
		const moved = expectOk(await folder.tables.todos.rename(plain, 'moved'));
		expect(moved.path).toBe('todos/moved.md');
		expect(moved.version).toEqual(plain.version);

		// A sibling changes its extension and is rewritten between capture and delete.
		const renamedAudio = expectOk(
			await folder.files.move(late, 'todos/moved.wav'),
		);
		expectOk(await folder.files.replace(renamedAudio, 'rewritten'));
		expectOk(await folder.tables.todos.delete(moved));

		const paths = expectOk(await folder.files.list()).files.map(
			(file) => file.path,
		);
		expect(paths.sort()).toEqual(['todos/moved.wav', 'todos/plain.flac']);
		expect(
			new TextDecoder().decode(
				expectOk(await folder.files.read('todos/moved.wav')).bytes,
			),
		).toBe('rewritten');
	});

	test('a stale entry is refused by its own version, and nothing else decides', async () => {
		const folder = await open();
		const row = expectOk(
			await folder.tables.todos.create({
				stem: 'row',
				fields: { title: 'Row', done: false },
			}),
		);
		expectOk(await folder.tables.todos.update(row, { fields: { done: true } }));
		expect((await folder.tables.todos.rename(row, 'next')).error?.name).toBe(
			'Conflict',
		);
		expect((await folder.tables.todos.delete(row)).error?.name).toBe(
			'Conflict',
		);
		expect(expectOk(await folder.files.children('todos')).files).toEqual([
			'row.md',
		]);
	});

	test('stems are one literal segment; nested paths are not rows', async () => {
		const folder = await open();
		await folder.files.create(
			'todos/a/b.md',
			'---\ntitle: Nested\ndone: false\n---\n',
		);
		expect((await folder.tables.todos.get('a/b')).error?.name).toBe(
			'InvalidStem',
		);
		expect((await folder.tables.todos.list()).data!.entries).toEqual([]);

		const real = (
			await folder.tables.todos.create({
				stem: 'real',
				fields: { title: 'Real', done: false },
			})
		).data!;
		const forged = { ...real, path: 'todos/a/b.md' };
		expect(
			(await folder.tables.todos.writeSource(forged, 'x')).error?.name,
		).toBe('InvalidPath');
		expect(
			(await folder.tables.todos.update(forged, { fields: { done: true } }))
				.error?.name,
		).toBe('InvalidPath');
		expect((await folder.tables.todos.delete(forged)).error?.name).toBe(
			'InvalidPath',
		);
		expect((await folder.tables.todos.rename(forged, 'c')).error?.name).toBe(
			'InvalidPath',
		);

		// An externally written row with an invalid stem stays listable and readable.
		await folder.files.create(
			'todos/bad .md',
			'---\ntitle: B\ndone: false\n---\n',
		);
		const bad = (await folder.tables.todos.list()).data!.entries.find(
			(entry) => entry.path === 'todos/bad .md',
		)!;
		expect(bad.stem).toBeUndefined();
		expect(bad.issues?.[0]?.kind).toBe('filename');
		expect((await folder.tables.todos.get('bad ')).data?.path).toBe(
			'todos/bad .md',
		);
	});
});

describe('empty directories', () => {
	test('an empty directory lists, is removable, and works from the terminal', async () => {
		const folder = await open();
		expect((await folder.files.mkdir('empty')).error).toBeNull();
		expect((await folder.files.children('empty')).data).toEqual({
			files: [],
			directories: [],
		});
		expect((await folder.files.children('')).data!.directories).toEqual([
			'empty',
		]);
		expect((await folder.files.rmdir('empty')).error).toBeNull();
		expect((await folder.files.children('empty')).error?.name).toBe('NotFound');

		const terminal = folder.terminal();
		const made = await terminal.exec('mkdir -p a/b && ls a && ls a/b');
		expect(made.stderr).toBe('');
		expect(made.stdout).toBe('b\n');
		const removed = await terminal.exec('rmdir a/b && ls a');
		expect(removed.stderr).toBe('');
		expect(removed.stdout).toBe('');
	});
});
