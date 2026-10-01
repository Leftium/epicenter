/**
 * Todos File Operation Tests
 *
 * Drives the real Todos state module against a real browser folder over
 * fake IndexedDB. The file browser reaches every file, but each operation
 * keeps the rule its file needs.
 *
 * Key behaviors:
 * - Renaming or deleting a todo row changes only its Markdown file: a
 *   same-stem image, recording, or any other file stays where it was
 * - A raw delete removes only the version the person confirmed
 * - Rename and delete refuse while a draft cannot save, and the draft is kept
 * - A renamed open text file keeps its editor at the new path
 * - A raw file renamed into a todo row reopens as a todo, still selected
 * - Whichever editor is open on a row settles before its table rename or delete
 * - Typing that arrives during a rename or delete is kept, never forgotten
 * - A rename owns both paths until its editor is at the destination: saves
 *   wait for it, refreshes and opens leave its paths alone, and overlapping
 *   operations on either path are refused
 * - A rename never lands on an open editor, and a failed one keeps the input
 *   at the last accepted path without retrying
 * - A stale open or listing cannot replace or forget what is retained now
 * - A change hint from the folder rereads without a refresh call: clean
 *   editors adopt the saved text, and a dirty draft keeps its input
 * - A draft that cannot save is dropped only by an explicit discard
 * - A folder with contents is never deleted from the browser
 *
 * Fixtures write with the verb that states their intent: `create` for a new
 * file, `overwrite` for another writer landing on whatever is there, and a
 * read followed by `remove` for another writer deleting the file.
 */
import './svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { ApplyError, FileError, openFolder } from '@epicenter/folder/browser';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { expectOk } from 'wellcrafted/testing';
import { todosDefinition } from './definition.js';
import type { TodosFolder } from './platform/types.js';
import type { Todos } from './todos.svelte.js';

const { createTodos } = await import('./todos.svelte.ts');
const { stemOf } = await import('./editor.svelte.ts');

const opened: Todos[] = [];
let count = 0;

const ROW = '---\ntitle: Note\ndone: false\n---\n';
const UNSETTLED = 'Save or discard the open edits first.';
const BUSY =
	'Another change to this file is still in progress. Try again when it finishes.';

/** `adapt` wraps the folder the app sees, so a test can act inside an awaited file operation. */
async function open(
	adapt: (folder: TodosFolder) => TodosFolder = (folder) => folder,
) {
	const folder = adapt(
		expectOk(
			await openFolder({
				id: `todos-test-${count++}`,
				definition: todosDefinition,
				browser: {
					author: { name: 'Test', email: 'test@example.test' },
					commitOnEdit: false,
					indexedDb: { indexedDB: new IDBFactory(), IDBKeyRange },
				},
			}),
		),
	);
	const todos = createTodos(folder);
	opened.push(todos);
	await todos.refreshAll();
	return todos;
}

afterEach(async () => {
	for (const todos of opened.splice(0)) await todos.close();
});

/** The file's bytes now, or undefined when nothing is at the path. */
async function bytes(todos: Todos, path: string) {
	return (await todos.folder.files.read(path)).data?.bytes;
}

async function text(todos: Todos, path: string) {
	const read = await bytes(todos, path);
	return read === undefined ? undefined : new TextDecoder().decode(read);
}

/** Another writer deletes the file as it is now. */
async function removeNow(todos: Todos, path: string) {
	const { files } = todos.folder;
	expectOk(await files.remove(expectOk(await files.read(path))));
}

/** A folder that sends no change hints, so only explicit refreshes read it. */
const withoutHints = (folder: TodosFolder): TodosFolder => ({
	...folder,
	onFilesChanged: () => () => {},
});

function textEditor(todos: Todos) {
	const selection = todos.selection;
	if (selection?.kind !== 'file' || selection.file.kind !== 'text')
		throw new Error(
			`Expected an open text file, got ${JSON.stringify(selection)}`,
		);
	return selection.file.editor;
}

/**
 * Bun resolves `svelte/reactivity` to Svelte's server entry, where `SvelteMap`
 * is a plain `Map`. Here `selection` recomputes only when the selected path
 * or the row list changes, so a test that already read it selects away and
 * back before reading what the same path retains now.
 */
async function reselect(todos: Todos, path: string) {
	await todos.open('elsewhere');
	await todos.open(path);
}

function todoEditor(todos: Todos) {
	const selection = todos.selection;
	if (selection?.kind !== 'todo')
		throw new Error(`Expected an open todo, got ${JSON.stringify(selection)}`);
	return selection.editor;
}

type Move = TodosFolder['files']['move'];

/**
 * A folder whose raw move and remove really land before the app hears back.
 * Once one has landed it calls `during.act`, and while `during.hold` is set
 * it keeps the result back until `during.release()`: the window in which a
 * person types, saves, or starts something else. `during.refuse` answers a
 * move instead of performing it. Raw saves (`create`, `replace`, and
 * `overwrite`) are recorded by path.
 */
function interceptingFileOperations() {
	const during: {
		act?: () => void;
		hold: boolean;
		release?: () => void;
		refuse?: (from: string, to: string) => ReturnType<Move>;
		moves: number;
		writes: string[];
	} = { hold: false, moves: 0, writes: [] };
	async function landed<T>(result: T): Promise<T> {
		during.act?.();
		if (during.hold)
			await new Promise<void>((resolve) => {
				during.release = resolve;
			});
		return result;
	}
	const adapt = (folder: TodosFolder): TodosFolder => ({
		...folder,
		files: {
			...folder.files,
			async move(file, destination) {
				during.moves++;
				return landed(
					await (during.refuse?.(file.path, destination) ??
						folder.files.move(file, destination)),
				);
			},
			async remove(file) {
				return landed(await folder.files.remove(file));
			},
			create(path, content) {
				during.writes.push(path);
				return folder.files.create(path, content);
			},
			replace(file, content) {
				during.writes.push(file.path);
				return folder.files.replace(file, content);
			},
			overwrite(path, content) {
				during.writes.push(path);
				return folder.files.overwrite(path, content);
			},
		},
	});
	/** Resolves once a held operation has landed and is waiting to answer. */
	async function held() {
		while (during.release === undefined) await Bun.sleep(1);
		const release = during.release;
		during.release = undefined;
		during.hold = false;
		return release;
	}
	return { during, adapt, held };
}

// ============================================================================
// A todo row is one Markdown file; same-stem files are ordinary files
// ============================================================================

const PNG = new Uint8Array([0x89, 0x50, 0]);
const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]);
const SIDECAR = 'an ordinary file that shares the stem\n';

/** An image, a recording, and a text file beside the row at `path`, by stem. */
async function addSiblings(todos: Todos, path: string) {
	const stem = path.replace(/\.md$/, '');
	const { files } = todos.folder;
	expectOk(await files.create(`${stem}.png`, PNG));
	expectOk(await files.create(`${stem}.webm`, WEBM));
	expectOk(await files.create(`${stem}.txt`, SIDECAR));
	return stem;
}

async function expectSiblings(todos: Todos, stem: string) {
	expect(await bytes(todos, `${stem}.png`)).toEqual(PNG);
	expect(await bytes(todos, `${stem}.webm`)).toEqual(WEBM);
	expect(await text(todos, `${stem}.txt`)).toBe(SIDECAR);
}

async function expectNoSiblings(todos: Todos, stem: string) {
	for (const extension of ['png', 'webm', 'txt'])
		expect(await bytes(todos, `${stem}.${extension}`)).toBeUndefined();
}

test('deleting a todo row removes only its Markdown file and leaves same-stem files in place', async () => {
	const todos = await open();
	expect(await todos.create('Milk')).toBeUndefined();
	const path = todos.selectedPath!;
	const stem = await addSiblings(todos, path);
	await todos.refresh();

	const deletion = expectOk(await todos.deletionFor(path));
	expect(deletion).toMatchObject({ kind: 'todo', entry: { path } });
	expect(await todos.remove(deletion)).toBeUndefined();
	expect(await text(todos, path)).toBeUndefined();
	await expectSiblings(todos, stem);
	expect(todos.selectedPath).toBeUndefined();
	expect(todos.entries).toEqual([]);
	// The files that stayed are still listed and open as what they are.
	await todos.open(`${stem}.png`);
	expect(todos.selection).toMatchObject({
		kind: 'file',
		file: { kind: 'binary', size: PNG.byteLength },
	});
});

test('renaming a todo row moves only its Markdown file, and its editor follows while same-stem files stay', async () => {
	const todos = await open();
	await todos.create('Milk');
	const path = todos.selectedPath!;
	const editor = todoEditor(todos);
	const source = editor.buffer;
	const stem = await addSiblings(todos, path);
	// Another row's editor and a sibling's raw editor are open and dirty.
	await todos.create('Bread');
	const otherPath = todos.selectedPath!;
	const other = todoEditor(todos);
	other.input(`${other.buffer}other typing\n`);
	await todos.open(`${stem}.txt`);
	const sidecar = textEditor(todos);
	sidecar.input(`${SIDECAR}typed\n`);
	await todos.open(path);

	expect(await todos.rename(path, 'renamed.md')).toBeUndefined();
	expect(await text(todos, 'todos/renamed.md')).toBe(source);
	expect(await text(todos, path)).toBeUndefined();
	await expectNoSiblings(todos, 'todos/renamed');
	expect(await bytes(todos, `${stem}.png`)).toEqual(PNG);
	expect(await bytes(todos, `${stem}.webm`)).toEqual(WEBM);

	// The renamed row's editor is the same editor, now at the new path.
	expect(todos.selectedPath).toBe('todos/renamed.md');
	expect(todoEditor(todos)).toBe(editor);
	expect(editor.path).toBe('todos/renamed.md');
	// The other editors were not retargeted and still save where they were.
	expect(other.path).toBe(otherPath);
	expect(sidecar.path).toBe(`${stem}.txt`);
	await other.save();
	await sidecar.save();
	expect(await text(todos, otherPath)).toContain('other typing');
	expect(await text(todos, `${stem}.txt`)).toBe(`${SIDECAR}typed\n`);
	expect(todos.unsaved).toBe(false);

	// Typing in the renamed editor saves at the new path only.
	editor.input(`${source}after\n`);
	await editor.save();
	expect(await text(todos, 'todos/renamed.md')).toBe(`${source}after\n`);
	expect(await text(todos, path)).toBeUndefined();
});

test('a same-stem file added after the row editor opened is untouched by a later rename and delete', async () => {
	const todos = await open();
	await todos.create('Milk');
	const path = todos.selectedPath!;
	const stem = await addSiblings(todos, path);

	expect(await todos.rename(path, 'renamed.md')).toBeUndefined();
	await expectSiblings(todos, stem);
	const deletion = expectOk(await todos.deletionFor('todos/renamed.md'));
	expect(await todos.remove(deletion)).toBeUndefined();
	expect(await text(todos, 'todos/renamed.md')).toBeUndefined();
	await expectSiblings(todos, stem);
	await expectNoSiblings(todos, 'todos/renamed');
});

// ============================================================================
// Retained drafts and stale observations
// ============================================================================

test('refresh forgets a removed idle todo but retains a removed dirty draft until discarded', async () => {
	const todos = await open();
	await todos.create('Idle');
	const idlePath = todos.selectedPath!;
	await removeNow(todos, idlePath);
	await todos.refresh();
	expect(todos.selection).toBeUndefined();
	expect(todos.unsaved).toBe(false);

	await todos.create('Dirty');
	const path = todos.selectedPath!;
	const selection = todos.selection;
	if (selection?.kind !== 'todo') throw new Error('Expected todo selection');
	const editor = selection.editor;
	editor.input(`${editor.buffer}mine\n`);
	await removeNow(todos, path);
	await todos.refresh();
	expect(todos.selection?.kind).toBe('todo');
	expect(editor.buffer).toContain('mine');
	await editor.save();
	expect(editor.saveState).toMatchObject({
		kind: 'conflict',
		current: undefined,
	});
	expect(todos.unsaved).toBe(true);
	todos.discard(path);
	expect(todos.selection).toBeUndefined();
	expect(todos.unsaved).toBe(false);
});

test('a removed raw draft can be explicitly discarded after its save conflicts', async () => {
	const todos = await open();
	await todos.folder.files.create('notes.txt', 'saved');
	await todos.open('notes.txt');
	const editor = textEditor(todos);
	editor.input('mine');
	await removeNow(todos, 'notes.txt');
	await editor.save();
	expect(editor.buffer).toBe('mine');
	expect(todos.unsaved).toBe(true);
	todos.discard('notes.txt');
	expect(todos.selection).toBeUndefined();
	expect(todos.unsaved).toBe(false);
});

test('an older refresh cannot forget a todo opened by a newer refresh', async () => {
	const todos = await open();
	const table = todos.folder.tables.todos;
	const list = table.list.bind(table);
	const captured = await list();
	let release!: () => void;
	const delayed = new Promise<void>((resolve) => {
		release = resolve;
	});
	let first = true;
	table.list = async () => {
		if (!first) return list();
		first = false;
		await delayed;
		return captured;
	};
	const older = todos.refresh();
	try {
		await todos.create('New');
		const path = todos.selectedPath;
		release();
		await older;
		expect(todos.selectedPath).toBe(path);
		expect(todos.selection?.kind).toBe('todo');
		expect(todos.entries).toHaveLength(1);
	} finally {
		release();
		await older;
		table.list = list;
	}
});

test('a listing requested before a file was opened cannot forget it', async () => {
	let release: (() => void) | undefined;
	let hold = false;
	// Without hints the held listing stays the newest pass, so what protects
	// the editor is what that pass was requested for, not a newer pass.
	const todos = await open((folder) => ({
		...withoutHints(folder),
		files: {
			...folder.files,
			async list() {
				const listed = await folder.files.list();
				if (hold) await new Promise<void>((resolve) => (release = resolve));
				return listed;
			},
		},
	}));

	hold = true;
	const older = todos.refresh();
	while (release === undefined) await Bun.sleep(1);
	hold = false;
	await todos.folder.files.create('notes.txt', 'saved');
	await todos.open('notes.txt');
	const editor = textEditor(todos);
	release();
	await older;
	expect(textEditor(todos)).toBe(editor);
	expect(todos.selectedPath).toBe('notes.txt');
});

test('toggle reports an open draft conflict instead of claiming success', async () => {
	const todos = await open();
	await todos.create('Milk');
	const selection = todos.selection;
	if (selection?.kind !== 'todo') throw new Error('Expected todo selection');
	const editor = selection.editor;
	await todos.folder.files.overwrite(editor.path, `${editor.buffer}theirs\n`);
	expect(await todos.toggle(editor.baseline)).toBeDefined();
	expect(editor.saveState.kind).toBe('conflict');
	expect(editor.buffer).not.toContain('theirs');
});

test('a raw delete removes only the version that was confirmed', async () => {
	const todos = await open();
	await todos.folder.files.create('notes.txt', 'first');
	await todos.refresh();
	const deletion = await todos.deletionFor('notes.txt');
	expect(deletion.data?.kind).toBe('file');

	await todos.folder.files.overwrite('notes.txt', 'second');
	const problem = await todos.remove(deletion.data!);
	expect(problem).toContain('changed after it was read');
	expect(await text(todos, 'notes.txt')).toBe('second');
});

test('rename and delete refuse while a draft cannot save, and keep the draft', async () => {
	const todos = await open();
	await todos.folder.files.create('notes.txt', 'saved');
	await todos.refresh();
	await todos.open('notes.txt');
	const editor = textEditor(todos);

	await todos.folder.files.overwrite('notes.txt', 'theirs');
	editor.input('mine');
	await editor.save();
	expect(editor.saveState.kind).toBe('conflict');

	expect(await todos.rename('notes.txt', 'renamed.txt')).toBe(
		'Save or discard the open edits first.',
	);
	expect((await todos.deletionFor('notes.txt')).error).toBe(
		'Save or discard the open edits first.',
	);
	expect(editor.buffer).toBe('mine');
	expect(await text(todos, 'notes.txt')).toBe('theirs');

	await editor.keepMine();
	expect(editor.saveState.kind).toBe('saved');
	expect(await text(todos, 'notes.txt')).toBe('mine');
});

test('a renamed open text file keeps its editor at the new path', async () => {
	const todos = await open();
	await todos.folder.files.create('notes.txt', 'hello');
	await todos.refresh();
	await todos.open('notes.txt');
	const editor = textEditor(todos);

	expect(await todos.rename('notes.txt', 'hello.txt')).toBeUndefined();
	expect(todos.selectedPath).toBe('hello.txt');
	expect(textEditor(todos)).toBe(editor);
	expect(editor.path).toBe('hello.txt');
	expect(await text(todos, 'notes.txt')).toBeUndefined();

	editor.input('hello again');
	await editor.save();
	expect(await text(todos, 'hello.txt')).toBe('hello again');
});

test('a raw file renamed into a todo row settles, then reopens as a todo at the selected destination', async () => {
	const todos = await open();
	await todos.folder.files.create('todos/note.txt', ROW);
	await todos.refresh();
	await todos.open('todos/note.txt');
	textEditor(todos).input(`${ROW}mine\n`);

	expect(await todos.rename('todos/note.txt', 'note.md')).toBeUndefined();
	expect(todos.selectedPath).toBe('todos/note.md');
	const selection = todos.selection;
	if (selection?.kind !== 'todo') throw new Error('Expected todo selection');
	expect(selection.editor.buffer).toBe(`${ROW}mine\n`);
	expect(selection.entry?.fields.title).toBe('Note');
	expect(todos.unsaved).toBe(false);
	expect(await text(todos, 'todos/note.txt')).toBeUndefined();
});

test('typing during a rename into a todo row keeps the raw editor until it is clean, then the row opens as a todo', async () => {
	const { during, adapt } = interceptingFileOperations();
	const todos = await open(adapt);
	await todos.folder.files.create('todos/note.txt', ROW);
	await todos.refresh();
	await todos.open('todos/note.txt');
	const editor = textEditor(todos);

	during.act = () => editor.input(`${ROW}typed during\n`);
	expect(await todos.rename('todos/note.txt', 'note.md')).toBeUndefined();
	during.act = undefined;
	expect(todos.selectedPath).toBe('todos/note.md');
	expect(textEditor(todos)).toBe(editor);
	expect(editor.buffer).toBe(`${ROW}typed during\n`);
	expect(todos.unsaved).toBe(true);

	// The table now lists the row, so its rename goes through the table and
	// first saves what the raw editor holds. Clean, it gives way to a todo.
	// The same-stem image is not the row's and stays.
	expect(todos.isTodo('todos/note.md')).toBe(true);
	await todos.folder.files.create('todos/note.png', new Uint8Array([7]));
	during.writes.length = 0;
	expect(await todos.rename('todos/note.md', 'kept.md')).toBeUndefined();
	expect(during.writes).toEqual(['todos/note.md']);
	expect(await text(todos, 'todos/kept.md')).toBe(`${ROW}typed during\n`);
	expect(await bytes(todos, 'todos/note.png')).toEqual(new Uint8Array([7]));
	expect(await bytes(todos, 'todos/kept.png')).toBeUndefined();
	expect(todos.selectedPath).toBe('todos/kept.md');
	expect(todoEditor(todos).buffer).toBe(`${ROW}typed during\n`);
	expect(todos.unsaved).toBe(false);
});

// ============================================================================
// A rename owns its paths until the editor is at the destination
// ============================================================================

test('typing and saving after the bytes moved, before the rename answers, wait and then save at the destination', async () => {
	const { during, adapt, held } = interceptingFileOperations();
	const todos = await open(adapt);
	await todos.folder.files.create('todos/draft.txt', 'saved');
	await todos.refresh();
	await todos.open('todos/draft.txt');
	const editor = textEditor(todos);

	during.writes.length = 0;
	during.hold = true;
	const renaming = todos.rename('todos/draft.txt', 'renamed.txt');
	const release = await held();
	expect(await text(todos, 'todos/renamed.txt')).toBe('saved');
	expect(await text(todos, 'todos/draft.txt')).toBeUndefined();

	editor.input('new typing');
	await editor.save();
	expect(during.writes).toEqual([]);
	expect(editor.saveState).toEqual({ kind: 'saved' });
	expect(editor.path).toBe('todos/draft.txt');
	expect(todos.unsaved).toBe(true);

	release();
	expect(await renaming).toBeUndefined();
	expect(editor.path).toBe('todos/renamed.txt');
	expect(editor.buffer).toBe('new typing');
	expect(todos.selectedPath).toBe('todos/renamed.txt');
	expect(textEditor(todos)).toBe(editor);

	await editor.save();
	expect(during.writes).toEqual(['todos/renamed.txt']);
	expect(editor.saveState).toEqual({ kind: 'saved' });
	expect(await text(todos, 'todos/renamed.txt')).toBe('new typing');
	expect(todos.unsaved).toBe(false);
});

test('closing during a rename waits for it, then saves the held typing at the destination', async () => {
	const { during, adapt, held } = interceptingFileOperations();
	const todos = await open(adapt);
	await todos.folder.files.create('notes.txt', 'saved');
	await todos.refresh();
	await todos.open('notes.txt');
	const editor = textEditor(todos);

	during.writes.length = 0;
	during.hold = true;
	const renaming = todos.rename('notes.txt', 'renamed.txt');
	const release = await held();
	editor.input('new typing');
	let closed = false;
	const closing = todos.close().then(() => {
		closed = true;
	});
	opened.splice(opened.indexOf(todos), 1);
	await Bun.sleep(5);
	expect(closed).toBe(false);
	expect(during.writes).toEqual([]);

	release();
	expect(await renaming).toBeUndefined();
	await closing;
	expect(during.writes).toEqual(['renamed.txt']);
	expect(editor.path).toBe('renamed.txt');
	expect(editor.dirty).toBe(false);
});

test('a refresh that finds the source gone during a rename leaves its editor to the rename', async () => {
	const { during, adapt, held } = interceptingFileOperations();
	const todos = await open(adapt);
	await todos.folder.files.create('notes.txt', 'saved');
	await todos.refresh();
	await todos.open('notes.txt');
	const editor = textEditor(todos);

	during.writes.length = 0;
	during.hold = true;
	const renaming = todos.rename('notes.txt', 'renamed.txt');
	const release = await held();
	await todos.refresh();
	const listed = todos.listing?.files.map((file) => file.path);
	expect(listed).toContain('renamed.txt');
	expect(listed).not.toContain('notes.txt');
	expect(todos.selectedPath).toBe('notes.txt');

	release();
	expect(await renaming).toBeUndefined();
	expect(todos.selectedPath).toBe('renamed.txt');
	expect(textEditor(todos)).toBe(editor);
	editor.input('after');
	await editor.save();
	expect(await text(todos, 'renamed.txt')).toBe('after');
});

test('operations on either path of a rename in progress are refused, and other paths are not', async () => {
	const { during, adapt, held } = interceptingFileOperations();
	const todos = await open(adapt);
	for (const path of ['a.txt', 'b.txt', 'other.txt'])
		await todos.folder.files.create(path, path);
	await todos.refresh();
	await todos.open('a.txt');
	const editor = textEditor(todos);

	during.writes.length = 0;
	during.hold = true;
	const renaming = todos.rename('a.txt', 'c.txt');
	const release = await held();
	expect(await todos.rename('a.txt', 'd.txt')).toBe(BUSY);
	expect(await todos.rename('b.txt', 'c.txt')).toBe(BUSY);
	expect(await todos.rename('b.txt', 'a.txt')).toContain('open in an editor');
	expect((await todos.deletionFor('a.txt')).error).toBe(BUSY);
	expect((await todos.deletionFor('c.txt')).error).toBe(BUSY);
	expect(await todos.createFile('', 'c.txt')).toBe(BUSY);
	todos.discard('a.txt');
	expect(await todos.rename('other.txt', 'free.txt')).toBeUndefined();
	// Opening the destination selects it but claims nothing while it is reserved.
	await todos.open('c.txt');
	expect(todos.selection).toBeUndefined();
	expect(await text(todos, 'b.txt')).toBe('b.txt');

	release();
	expect(await renaming).toBeUndefined();
	expect(todos.selectedPath).toBe('c.txt');
	await reselect(todos, 'c.txt');
	expect(textEditor(todos)).toBe(editor);
	expect(editor.path).toBe('c.txt');
	expect(await todos.rename('c.txt', 'd.txt')).toBeUndefined();
	expect(editor.path).toBe('d.txt');
});

test('a todo rename holds its editor and refuses a toggle until the row is at its new path', async () => {
	const todos = await open();
	await todos.create('Milk');
	const path = todos.selectedPath!;
	const editor = todoEditor(todos);
	const original = editor.buffer;
	const image = path.replace(/\.md$/, '.png');
	await todos.folder.files.create(image, new Uint8Array([7]));
	const table = todos.folder.tables.todos;
	const rename = table.rename.bind(table);
	let release: (() => void) | undefined;
	table.rename = async (...args) => {
		const renamed = await rename(...args);
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		return renamed;
	};

	const renaming = todos.rename(path, 'oat.md');
	while (release === undefined) await Bun.sleep(1);
	table.rename = rename;
	expect(await todos.toggle(todos.entries[0]!)).toBe(BUSY);
	editor.input(`${original}typed during\n`);
	await editor.save();
	expect(editor.saveState).toEqual({ kind: 'saved' });
	expect(await text(todos, 'todos/oat.md')).toBe(original);

	release();
	expect(await renaming).toBeUndefined();
	expect(todos.selectedPath).toBe('todos/oat.md');
	expect(todoEditor(todos)).toBe(editor);
	expect(editor.path).toBe('todos/oat.md');
	// The same-stem image did not move with the row.
	expect(await bytes(todos, image)).toEqual(new Uint8Array([7]));
	expect(await bytes(todos, 'todos/oat.png')).toBeUndefined();
	await editor.save();
	expect(await text(todos, 'todos/oat.md')).toBe(`${original}typed during\n`);
	expect(await text(todos, path)).toBeUndefined();
	expect(await todos.toggle(todos.entries[0]!)).toBeUndefined();
	expect(editor.buffer).toContain('done: true');
});

test('a rename never lands on an open editor, clean or holding a removed draft', async () => {
	const todos = await open();
	for (const path of ['a.txt', 'b.txt'])
		await todos.folder.files.create(path, path);
	await todos.refresh();
	await todos.open('b.txt');
	const destination = textEditor(todos);
	await todos.open('a.txt');
	const source = textEditor(todos);

	expect(await todos.rename('a.txt', 'b.txt')).toContain('open in an editor');
	destination.input('mine');
	await removeNow(todos, 'b.txt');
	expect(await todos.rename('a.txt', 'b.txt')).toContain('open in an editor');

	expect(await text(todos, 'a.txt')).toBe('a.txt');
	expect(source.path).toBe('a.txt');
	expect(destination.buffer).toBe('mine');
	await todos.open('b.txt');
	expect(textEditor(todos)).toBe(destination);
});

test('an open of the destination that resolves after the bytes moved gives up its claim to the rename', async () => {
	const { during, adapt, held } = interceptingFileOperations();
	let gate: Promise<void> | undefined;
	const todos = await open((folder) => {
		const adapted = adapt(folder);
		return {
			...adapted,
			files: {
				...adapted.files,
				async read(path) {
					await gate;
					return folder.files.read(path);
				},
			},
		};
	});
	await todos.folder.files.create('a.txt', 'saved');
	await todos.refresh();
	await todos.open('a.txt');
	const editor = textEditor(todos);

	let ungate = () => {};
	gate = new Promise<void>((resolve) => {
		ungate = resolve;
	});
	const opening = todos.open('c.txt');
	during.writes.length = 0;
	during.hold = true;
	const renaming = todos.rename('a.txt', 'c.txt');
	const release = await held();
	gate = undefined;
	ungate();
	await opening;
	// The open read the moved bytes, but the path belongs to the rename.
	expect(todos.selection).toBeUndefined();
	expect(todos.saving || todos.unsaved).toBe(false);

	release();
	expect(await renaming).toBeUndefined();
	await reselect(todos, 'c.txt');
	expect(textEditor(todos)).toBe(editor);
	expect(editor.path).toBe('c.txt');
});

test('a rename that fails partway keeps the input at the last accepted path and does not retry', async () => {
	const { during, adapt } = interceptingFileOperations();
	const todos = await open(adapt);
	await todos.folder.files.create('notes.txt', 'saved');
	await todos.refresh();
	await todos.open('notes.txt');
	const editor = textEditor(todos);

	during.writes.length = 0;
	during.refuse = async (from, to) =>
		ApplyError.Partial({
			applied: [],
			failed: { kind: 'move', from, to },
			error: FileError.Io({
				path: from,
				operation: 'move',
				cause: new Error('disk unplugged'),
			}).error,
			notAttempted: [],
		});
	during.act = () => editor.input('typed during');
	expect(await todos.rename('notes.txt', 'renamed.txt')).toContain(
		'disk unplugged',
	);
	during.act = undefined;
	expect(editor.path).toBe('notes.txt');
	expect(editor.buffer).toBe('typed during');
	expect(editor.saveState).toEqual({ kind: 'saved' });
	expect(todos.selectedPath).toBe('notes.txt');
	expect(textEditor(todos)).toBe(editor);

	// The held input saves against the unchanged baseline; nothing is moved again.
	await editor.save();
	expect(during.moves).toBe(1);
	expect(during.writes).toEqual(['notes.txt']);
	expect(await text(todos, 'notes.txt')).toBe('typed during');
	expect(await text(todos, 'renamed.txt')).toBeUndefined();
});

test('a raw editor opened on a row while the table list failed settles before table rename and delete', async () => {
	const todos = await open();
	const table = todos.folder.tables.todos;
	const list = table.list.bind(table);
	// The list fails from before the row exists, so the reread its creation
	// hints cannot list it either.
	table.list = async () =>
		FileError.Io({
			path: 'todos',
			operation: 'list',
			cause: new Error('unavailable'),
		});
	try {
		await todos.folder.files.create('todos/milk.md', ROW);
		await todos.open('todos/milk.md');
	} finally {
		table.list = list;
	}
	expect(todos.listError).toContain('unavailable');
	const editor = textEditor(todos);
	await todos.refresh();
	expect(todos.isTodo('todos/milk.md')).toBe(true);
	await todos.folder.files.create('todos/milk.png', new Uint8Array([7]));

	// A toggle goes into the raw editor that owns the row, not around it.
	const done = ROW.replace('done: false', 'done: true');
	expect(await todos.toggle(todos.entries[0]!)).toBeUndefined();
	expect(editor.buffer).toBe(done);
	expect(await text(todos, 'todos/milk.md')).toBe(done);

	// A draft that cannot save refuses both operations and is kept.
	await todos.folder.files.overwrite('todos/milk.md', `${ROW}theirs\n`);
	editor.input(`${ROW}mine\n`);
	expect(await todos.rename('todos/milk.md', 'oat.md')).toBe(UNSETTLED);
	expect((await todos.deletionFor('todos/milk.md')).error).toBe(UNSETTLED);
	expect(await text(todos, 'todos/milk.md')).toBe(`${ROW}theirs\n`);
	await editor.keepMine();

	// The settled raw editor gives way to the row's todo editor at the new path.
	editor.input(`${ROW}mine again\n`);
	expect(await todos.rename('todos/milk.md', 'oat.md')).toBeUndefined();
	expect(await text(todos, 'todos/oat.md')).toBe(`${ROW}mine again\n`);
	expect(await text(todos, 'todos/milk.md')).toBeUndefined();
	// The table rename moved the row alone; the image kept its name.
	expect(await bytes(todos, 'todos/milk.png')).toEqual(new Uint8Array([7]));
	expect(await bytes(todos, 'todos/oat.png')).toBeUndefined();
	expect(todos.selectedPath).toBe('todos/oat.md');
	const todo = todoEditor(todos);
	await todos.folder.files.create('todos/oat.webm', new Uint8Array([9]));

	todo.input(`${ROW}last\n`);
	const deletion = await todos.deletionFor('todos/oat.md');
	expect(deletion.data).toMatchObject({
		kind: 'todo',
		entry: { path: 'todos/oat.md', source: `${ROW}last\n` },
	});
	expect(await todos.remove(deletion.data!)).toBeUndefined();
	expect(await text(todos, 'todos/oat.md')).toBeUndefined();
	// The table delete removed the row alone.
	expect(await bytes(todos, 'todos/oat.webm')).toEqual(new Uint8Array([9]));
	expect(await bytes(todos, 'todos/milk.png')).toEqual(new Uint8Array([7]));
	expect(todos.selection).toBeUndefined();
	expect(todos.unsaved).toBe(false);
});

test('typing during a delete stays as a draft of the removed file until it is discarded', async () => {
	const { during, adapt } = interceptingFileOperations();
	const todos = await open(adapt);
	await todos.folder.files.create('notes.txt', 'saved');
	await todos.refresh();
	await todos.open('notes.txt');
	const editor = textEditor(todos);
	const deletion = await todos.deletionFor('notes.txt');

	during.act = () => editor.input('typed during');
	expect(await todos.remove(deletion.data!)).toBeUndefined();
	during.act = undefined;
	expect(await text(todos, 'notes.txt')).toBeUndefined();
	expect(textEditor(todos)).toBe(editor);
	expect(editor.buffer).toBe('typed during');
	expect(todos.unsaved).toBe(true);

	await editor.save();
	expect(editor.saveState).toMatchObject({
		kind: 'conflict',
		current: undefined,
	});
	todos.discard('notes.txt');
	expect(todos.selection).toBeUndefined();
	expect(todos.unsaved).toBe(false);
});

test('a draft whose saved file became unreadable is kept until it is explicitly discarded, then reopens as details', async () => {
	const todos = await open();
	await todos.folder.files.create('notes.txt', 'saved');
	await todos.refresh();
	await todos.open('notes.txt');
	const editor = textEditor(todos);
	const binary = new Uint8Array([0x89, 0, 1]);

	editor.input('mine');
	await todos.folder.files.overwrite('notes.txt', binary);
	await editor.save();
	expect(editor.saveState).toEqual({
		kind: 'failed',
		message: expect.stringContaining('not text'),
	});
	// Nothing but the explicit choice drops the input: not a retry, not a refresh.
	await editor.retry();
	await todos.refresh();
	expect(editor.saveState.kind).toBe('failed');
	expect(editor.buffer).toBe('mine');
	expect(todos.selectedPath).toBe('notes.txt');
	expect(todos.saveProblems).toBe(1);

	todos.discard('notes.txt');
	expect(todos.selection).toBeUndefined();
	expect(todos.unsaved).toBe(false);
	expect(await bytes(todos, 'notes.txt')).toEqual(binary);
	await todos.open('notes.txt');
	expect(todos.selection).toMatchObject({
		kind: 'file',
		file: { kind: 'binary', size: 3 },
	});
});

test('a clean or merely dirty editor is not discarded', async () => {
	const todos = await open();
	await todos.folder.files.create('notes.txt', 'saved');
	await todos.refresh();
	await todos.open('notes.txt');
	const editor = textEditor(todos);

	todos.discard('notes.txt');
	editor.input('mine');
	todos.discard('notes.txt');
	expect(todos.selectedPath).toBe('notes.txt');
	expect(editor.buffer).toBe('mine');

	// A changed file is reviewed through its conflict choices, not discarded here.
	await todos.folder.files.overwrite('notes.txt', 'theirs');
	await editor.save();
	expect(editor.saveState.kind).toBe('conflict');
	todos.discard('notes.txt');
	expect(todos.selectedPath).toBe('notes.txt');
	expect(editor.buffer).toBe('mine');
});

test('an open that resolves after its path was deleted and reopened cannot replace the newer file', async () => {
	const gates: (() => void)[] = [];
	let hold = false;
	const todos = await open((folder) => ({
		...folder,
		files: {
			...folder.files,
			async read(path) {
				const read = await folder.files.read(path);
				if (hold) await new Promise<void>((resolve) => gates.push(resolve));
				return read;
			},
		},
	}));
	await todos.folder.files.create('notes.txt', 'old');
	await todos.refresh();

	hold = true;
	const stale = todos.open('notes.txt');
	while (gates.length < 1) await Bun.sleep(1);
	hold = false;
	const deletion = await todos.deletionFor('notes.txt');
	expect(await todos.remove(deletion.data!)).toBeUndefined();
	expect(todos.selection).toBeUndefined();
	await todos.folder.files.create('notes.txt', 'new');
	hold = true;
	const current = todos.open('notes.txt');
	while (gates.length < 2) await Bun.sleep(1);
	hold = false;

	// The stale result opens no editor. `selection` is not read here; see `reselect`.
	gates[0]!();
	await stale;
	expect(todos.saving || todos.unsaved || todos.saveProblems > 0).toBe(false);
	gates[1]!();
	await current;
	const editor = textEditor(todos);
	expect(editor.baseline.source).toBe('new');
	editor.input('mine');
	await editor.save();
	expect(await text(todos, 'notes.txt')).toBe('mine');
});

test('non-text files open as details, and todo rows open their todo editor', async () => {
	const todos = await open();
	await todos.folder.files.create('photo.png', new Uint8Array([0x89, 0, 1]));
	expect(await todos.create('Bread')).toBeUndefined();
	const row = todos.selectedPath!;
	await todos.refresh();

	await todos.open('photo.png');
	expect(todos.selection).toMatchObject({
		kind: 'file',
		file: { kind: 'binary', size: 3 },
	});
	await todos.open(row);
	expect(todos.selection?.kind).toBe('todo');
});

test('a folder is deleted from the browser only when it is empty', async () => {
	const todos = await open();
	expect(await todos.createFolder('', 'docs')).toBeUndefined();
	expect(await todos.createFile('docs', 'a.txt')).toBeUndefined();
	expect((await todos.deletionFor('docs')).error).toContain(
		'Only empty folders',
	);

	const file = await todos.deletionFor('docs/a.txt');
	expect(await todos.remove(file.data!)).toBeUndefined();
	const folder = await todos.deletionFor('docs');
	expect(folder.data).toEqual({ kind: 'folder', path: 'docs' });
	expect(await todos.remove(folder.data!)).toBeUndefined();
	expect(todos.listing?.directories).not.toContain('docs');
});

// ============================================================================
// Change hints
// ============================================================================

/**
 * The app over one handle, and a second handle on the same storage standing
 * in for another tab. The storage carries a channel, so the app's handle
 * hears the other's saves only as hints.
 */
async function openWithAnotherTab() {
	const id = `todos-test-${count++}`;
	const environment = {
		indexedDB: new IDBFactory(),
		IDBKeyRange,
		BroadcastChannel,
	};
	const handle = async () =>
		expectOk(
			await openFolder({
				id,
				definition: todosDefinition,
				browser: {
					author: { name: 'Test', email: 'test@example.test' },
					commitOnEdit: false,
					indexedDb: environment,
				},
			}),
		);
	const todos = createTodos(await handle());
	opened.push(todos);
	await todos.refreshAll();
	return { todos, other: await handle() };
}

/** Wait for a reread the test did not request. The assertion follows the wait. */
async function eventually(settled: () => boolean) {
	for (let waited = 0; waited < 400 && !settled(); waited++) await Bun.sleep(5);
}

test('a hint from another tab rereads the folder: new rows are listed and a clean editor adopts the saved text', async () => {
	const { todos, other } = await openWithAnotherTab();
	try {
		expectOk(await todos.folder.files.create('notes.txt', 'saved'));
		await todos.open('notes.txt');
		const editor = textEditor(todos);

		expectOk(
			await other.tables.todos.create({
				stem: 'milk',
				fields: { title: 'Milk', done: false },
			}),
		);
		const theirs = expectOk(await other.files.read('notes.txt'));
		expectOk(await other.files.replace(theirs, 'theirs'));
		// Nothing here asks the app to refresh.
		await eventually(
			() => todos.isTodo('todos/milk.md') && editor.buffer === 'theirs',
		);
		expect(todos.entries.map((entry) => entry.path)).toEqual(['todos/milk.md']);
		expect(todos.listing?.files.map((file) => file.path)).toContain(
			'todos/milk.md',
		);
		expect(editor.buffer).toBe('theirs');
		expect(editor.dirty).toBe(false);

		// The adopted capture is the baseline of the next save.
		editor.input('mine after theirs');
		await editor.save();
		expect(editor.saveState).toEqual({ kind: 'saved' });
		expect(await text(todos, 'notes.txt')).toBe('mine after theirs');
	} finally {
		await other.close();
	}
});

test('a hint never replaces a dirty draft, and its next save reports the other writer', async () => {
	const { todos, other } = await openWithAnotherTab();
	try {
		await todos.create('Milk');
		const path = todos.selectedPath!;
		const editor = todoEditor(todos);
		const mine = `${editor.buffer}mine\n`;
		editor.input(mine);

		const theirs = expectOk(await other.tables.todos.get(stemOf(path)));
		expectOk(
			await other.tables.todos.update(theirs!, { fields: { done: true } }),
		);
		await eventually(() => todos.entries[0]?.fields.done === true);
		// The list shows the other tab's save; the editor still holds the input.
		expect(todos.entries[0]?.fields.done).toBe(true);
		expect(editor.buffer).toBe(mine);
		expect(todos.unsaved).toBe(true);

		await editor.save();
		expect(editor.saveState).toMatchObject({
			kind: 'conflict',
			current: { path, fields: { done: true } },
		});
		expect(editor.buffer).toBe(mine);
	} finally {
		await other.close();
	}
});

test('a hint that arrives after the app closed changes nothing', async () => {
	const { todos, other } = await openWithAnotherTab();
	try {
		await todos.close();
		opened.splice(opened.indexOf(todos), 1);
		expectOk(await other.files.create('todos/late.md', ROW));
		await Bun.sleep(20);
		expect(todos.entries).toEqual([]);
		expect(todos.isTodo('todos/late.md')).toBe(false);
	} finally {
		await other.close();
	}
});
