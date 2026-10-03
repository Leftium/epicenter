/**
 * Todos File Operation Tests
 *
 * Drives the real Todos state module against a real browser folder over
 * an in-memory OPFS stand-in. The file browser reaches every file, but each operation
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
 * - An open todo's controls and a toggle from the list share its one draft,
 *   and its save writes the whole draft over whatever the file holds; a
 *   toggle with no editor open changes the row as it is now
 * - A row the todo editor refuses opens in its source editor with the reason,
 *   and returns to fields once repaired; a valid row can switch to its source
 * - A row whose filename breaks the naming rules, or is empty, is addressed
 *   by its literal stem: it toggles, saves over another writer, keeps its
 *   draft, and renames only to a valid name
 * - Typing that arrives during a rename or delete is kept, never forgotten
 * - A rename owns both paths until its editor is at the destination: saves
 *   wait for it, refreshes and opens leave its paths alone, and overlapping
 *   operations on either path are refused. A todo editor reopens at the
 *   destination; when it cannot, the typing stays in the row's source editor
 * - A rename never lands on an open editor, and a failed one keeps the input
 *   at the last accepted path without retrying. A move that landed its
 *   destination but kept its source leaves both files, names both paths, and
 *   removes neither; a move whose reply was lost halts the todo's autosave
 *   so nothing is written back at a path the row may have left
 * - A stale open or listing cannot replace or forget what is retained now
 * - A change hint from the folder rereads without a refresh call: clean
 *   editors adopt the saved text, and a dirty draft keeps its input
 * - An open todo owns its delete: a running save finishes first and none
 *   starts during it. A delete whose reply was lost, landed or not, holds
 *   the todo clean or dirty, and typing during a delete that removed the row
 *   is held too: no timer, refresh, read, settle, toggle, rename, delete,
 *   source switch, or close writes the row back. Only the person's explicit
 *   save writes it, or their discard closes it
 * - Another tab's change, removal, or malformed rewrite holds a dirty todo
 *   draft: no autosave, settle, rename, delete, or toggle writes over it
 *   until the person saves mine (the whole draft, or the row again) or
 *   discards it (their version loads, or the malformed text opens raw)
 * - A draft that cannot save is dropped only by an explicit discard
 * - A folder with contents is never deleted from the browser
 * - Closing fences the app at once: later calls issue no folder or terminal
 *   work, a held open, listing, create, or rename retains nothing new, and
 *   every close call shares one completion
 * - Close waits for mutations that own a path. A read or fetch that answers
 *   late starts no further folder work and changes no state. The folder
 *   cancels a fetch still on the network
 *
 * Fixtures write with the verb that states their intent: `create` for a new
 * file, `overwrite` for another writer landing on whatever is there, and a
 * read followed by `remove` for another writer deleting the file.
 */
import './svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { FileError, MoveError, openFolder } from '@epicenter/folder/browser';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { testBrowserStorage } from '../../../../packages/folder/src/browser-storage.test-support.js';
import { todosDefinition } from './definition.js';
import type { TodosFolder } from './platform/types.js';
import type { Todos } from './todos.svelte.js';

const { createTodos } = await import('./todos.svelte.ts');

const opened: Todos[] = [];
let count = 0;

const ROW = '---\ntitle: Note\ndone: false\n---\n';
const ROW_PATH = /^todos\/[^/]+\.md$/;
const UNSETTLED = 'Save or discard the open edits first.';
const CLOSING = 'Todos is closing, so nothing was changed.';
const BUSY =
	'Another change to this file is still in progress. Try again when it finishes.';

/** `adapt` wraps the folder the app sees, so a test can act inside an awaited file operation. */
async function open(
	adapt: (folder: TodosFolder) => TodosFolder = (folder) => folder,
	remote?: { url: string; branch: string },
) {
	const folder = adapt(
		expectOk(
			await openFolder({
				id: `todos-test-${count++}`,
				definition: todosDefinition,
				browser: {
					author: { name: 'Test', email: 'test@example.test' },
					commitOnEdit: false,
					remote,
					...testBrowserStorage(),
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
		throw new Error(`Expected an open todo, got ${selection?.kind}`);
	return selection.editor;
}

function sourceEditor(todos: Todos) {
	const selection = todos.selection;
	if (selection?.kind !== 'source')
		throw new Error(`Expected a row source editor, got ${selection?.kind}`);
	return selection;
}

/** How a file reads as a todo now. */
async function reading(todos: Todos, path: string) {
	return todos.folder.tables.todos.inspect((await text(todos, path)) ?? '');
}

type Move = TodosFolder['files']['move'];

/** Holds the next finished reply after arming, until the test releases it. */
function createGate() {
	let pending:
		| {
				entered: PromiseWithResolvers<void>;
				released: PromiseWithResolvers<void>;
		  }
		| undefined;
	return {
		arm() {
			const entered = Promise.withResolvers<void>();
			const released = Promise.withResolvers<void>();
			pending = { entered, released };
			return async () => {
				await entered.promise;
				return released.resolve;
			};
		},
		async reply<TResult>(result: TResult): Promise<TResult> {
			const held = pending;
			pending = undefined;
			if (held !== undefined) {
				held.entered.resolve();
				await held.released.promise;
			}
			return result;
		},
	};
}

/**
 * A folder whose raw move and remove really land before the app hears back.
 * Once one has landed it calls `during.act`. Arming the gate keeps the next
 * result back: the window in which a person types, saves, or starts something
 * else. `during.refuse` answers a move instead of performing it. Raw saves
 * (`create`, `replace`, and `overwrite`) are recorded by path.
 */
function interceptingFileOperations() {
	const gate = createGate();
	const during: {
		act?: () => void;
		refuse?: (from: string, to: string) => ReturnType<Move>;
		moves: number;
		writes: string[];
	} = { moves: 0, writes: [] };
	async function landed<T>(result: T): Promise<T> {
		during.act?.();
		return gate.reply(result);
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
	return { during, adapt, arm: gate.arm };
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
	const source = (await text(todos, path))!;
	const stem = await addSiblings(todos, path);
	// Another row's editor and a sibling's raw editor are open and dirty.
	await todos.create('Bread');
	const otherPath = todos.selectedPath!;
	const other = todoEditor(todos);
	other.change({ body: 'other typing\n' });
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
	editor.change({ body: 'after\n' });
	await editor.save();
	expect(await text(todos, 'todos/renamed.md')).toBe(editor.state.source);
	expect((await reading(todos, 'todos/renamed.md')).body).toBe('after\n');
	expect(await text(todos, path)).toBeUndefined();
});

// ============================================================================
// Retained drafts and stale observations
// ============================================================================

test('refresh forgets a removed idle todo, and a removed draft is kept and writes its row again', async () => {
	const todos = await open();
	await todos.create('Idle');
	const idlePath = todos.selectedPath!;
	await removeNow(todos, idlePath);
	await todos.refresh();
	expect(todos.selection).toBeUndefined();
	expect(todos.unsaved).toBe(false);

	await todos.create('Dirty');
	const path = todos.selectedPath!;
	const editor = todoEditor(todos);
	// Fields that do not conform keep the draft from saving on its own.
	editor.change({ fields: { done: 'soon' } });
	await removeNow(todos, path);
	await todos.refresh();
	await editor.refresh();
	expect(todos.selection?.kind).toBe('todo');
	expect(editor.state.observation.kind).toBe('missing');
	expect(editor.state.document.fields.done).toBe('soon');
	expect(todos.unsaved).toBe(true);

	// Nothing guards a save against the removal: it writes the row again.
	editor.change({ body: 'mine\n' });
	editor.change({ fields: { done: false } });
	expect(await editor.save()).toBeUndefined();
	expect(await text(todos, path)).toBe(editor.state.source);
	expect(todos.unsaved).toBe(false);
});

test('a todo draft that cannot save is dropped only by an explicit discard, which writes nothing', async () => {
	const todos = await open();
	await todos.create('Milk');
	const path = todos.selectedPath!;
	const saved = await text(todos, path);
	const editor = todoEditor(todos);

	todos.discard(path);
	editor.change({ body: 'mine\n' });
	todos.discard(path);
	expect(todos.selectedPath).toBe(path);
	expect(todoEditor(todos)).toBe(editor);

	editor.change({ fields: { done: 'soon' } });
	expect(todos.saveProblems).toBe(1);
	todos.discard(path);
	expect(todos.selection).toBeUndefined();
	expect(todos.unsaved).toBe(false);
	expect(await text(todos, path)).toBe(saved);
	await todos.open(path);
	expect(todoEditor(todos).state.document.body).toBe('');
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

test('a toggle on an open todo saves its whole draft, and is refused while a change made elsewhere awaits review', async () => {
	const todos = await open();
	await todos.create('Milk');
	const path = todos.selectedPath!;
	const editor = todoEditor(todos);
	editor.change({ body: 'mine\n' });

	expect(await todos.toggle(todos.entries[0]!)).toBeUndefined();
	expect(editor.state.document).toEqual({
		fields: { title: 'Milk', done: true },
		body: 'mine\n',
	});
	expect(editor.isIdle).toBe(true);
	expect(await text(todos, path)).toBe(editor.state.source);

	// A toggle is not the person's choice about another writer's change.
	editor.change({ body: 'mine again\n' });
	const theirs = `${ROW}theirs\n`;
	expectOk(await todos.folder.files.overwrite(path, theirs));
	await editor.refresh();
	expect(editor.isAwaitingReview).toBe(true);
	expect(await todos.toggle(todos.entries[0]!)).toContain('changed elsewhere');
	expect(await text(todos, path)).toBe(theirs);
	expect(editor.state.document.body).toBe('mine again\n');
});

test('a toggle with no editor open changes the row as it is now, not as it was listed', async () => {
	const todos = await open(withoutHints);
	expectOk(await todos.folder.files.create('todos/milk.md', ROW));
	await todos.refresh();
	const listed = todos.entries[0]!;
	expectOk(
		await todos.folder.files.overwrite(
			'todos/milk.md',
			'---\ntitle: Oat milk\ndone: false\nowner: sam\n---\nNotes\n',
		),
	);

	expect(await todos.toggle(listed)).toBeUndefined();
	const toggled = await reading(todos, 'todos/milk.md');
	expect(toggled.fields).toEqual({ title: 'Oat milk', done: true });
	expect(toggled.body).toBe('Notes\n');
	expect(await text(todos, 'todos/milk.md')).toContain('"owner": "sam"');
	// The toggle opened no editor of its own, and nothing stays open.
	expect(todos.selection).toBeUndefined();
	expect(todos.unsaved).toBe(false);
});

for (const [stem, repaired] of [
	['bad ', 'good'],
	['', 'named'],
] as const)
	test(`a row at the literal stem ${JSON.stringify(stem)} is an ordinary todo: it toggles, saves over another writer, keeps its draft, and renames to any literal name`, async () => {
		const todos = await open(withoutHints);
		const path = `todos/${stem}.md`;
		expectOk(await todos.folder.files.create(path, ROW));
		await todos.refresh();
		const listed = todos.entries.find((entry) => entry.path === path)!;
		expect(listed.stem).toBe(stem);
		// A name is an address. It is never something to repair.
		expect(listed.issues).toEqual([]);

		// With no editor open, the toggle edits the row at that stem.
		expect(await todos.toggle(listed)).toBeUndefined();
		expect((await reading(todos, path)).fields).toEqual({
			title: 'Note',
			done: true,
		});

		await todos.open(path);
		const editor = todoEditor(todos);
		expect(editor.path).toBe(path);
		editor.change({ body: 'mine\n' });
		expectOk(await todos.folder.files.overwrite(path, `${ROW}theirs\n`));
		// The save writes the draft at the same stem, over the other writer.
		expect(await editor.save()).toBeUndefined();
		const mine = editor.state.source;
		expect(await text(todos, path)).toBe(mine);
		expect((await reading(todos, path)).body).toBe('mine\n');

		// A rename applies no naming rule: punctuation and a trailing space are
		// names like any other, and only a path outside the folder is refused.
		expect(await todos.rename(path, 'nested/b.md')).toBe(
			'A name cannot contain "/".',
		);
		expect(await text(todos, path)).toBe(mine);
		expect(await todos.rename(path, 'a: b? .md')).toBeUndefined();
		expect(await text(todos, path)).toBeUndefined();
		expect(await text(todos, 'todos/a: b? .md')).toBe(mine);
		expect(editor.path).toBe('todos/a: b? .md');
		expect(await todos.rename('todos/a: b? .md', `${repaired}.md`)).toBe(
			undefined,
		);
		expect(await text(todos, 'todos/a: b? .md')).toBeUndefined();
		const renamedPath = `todos/${repaired}.md`;
		expect(await text(todos, renamedPath)).toBe(mine);
		expect(todoEditor(todos)).toBe(editor);
		expect(editor.path).toBe(renamedPath);
		expect(editor.state.reading.issues).toEqual([]);

		// After the rename, typing saves where the row is now, over another writer.
		expectOk(
			await todos.folder.files.overwrite(
				renamedPath,
				`${mine}theirs after the rename\n`,
			),
		);
		editor.change({ body: 'mine after the rename\n' });
		expect(await editor.save()).toBeUndefined();
		expect(todoEditor(todos)).toBe(editor);
		expect((await reading(todos, renamedPath)).body).toBe(
			'mine after the rename\n',
		);
		// Nothing was written back at the names the row left.
		expect(await text(todos, path)).toBeUndefined();
		expect(await text(todos, 'todos/a: b? .md')).toBeUndefined();
	});

test('a raw delete removes only the version that was confirmed', async () => {
	const todos = await open();
	await todos.folder.files.create('notes.txt', 'first');
	await todos.refresh();
	const deletion = await todos.deletionFor('notes.txt');
	expect(deletion.data?.kind).toBe('file');

	await todos.folder.files.overwrite('notes.txt', 'second');
	const problem = await todos.remove(deletion.data!);
	expect(problem).toContain('different content now');
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
	expect(todoEditor(todos).state.document).toEqual({
		fields: { title: 'Note', done: false },
		body: 'mine\n',
	});
	expect(todos.unsaved).toBe(false);
	// The raw save wrote the text as typed; opening the todo rewrote nothing.
	expect(await text(todos, 'todos/note.md')).toBe(`${ROW}mine\n`);
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
	expect(todoEditor(todos).state.document.body).toBe('typed during\n');
	expect(todos.unsaved).toBe(false);
});

// ============================================================================
// A rename owns its paths until the editor is at the destination
// ============================================================================

test('typing and saving after the bytes moved, before the rename answers, wait and then save at the destination', async () => {
	const { during, adapt, arm } = interceptingFileOperations();
	const todos = await open(adapt);
	await todos.folder.files.create('todos/draft.txt', 'saved');
	await todos.refresh();
	await todos.open('todos/draft.txt');
	const editor = textEditor(todos);

	during.writes.length = 0;
	const held = arm();
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
	const { during, adapt, arm } = interceptingFileOperations();
	const todos = await open(adapt);
	await todos.folder.files.create('notes.txt', 'saved');
	await todos.refresh();
	await todos.open('notes.txt');
	const editor = textEditor(todos);

	during.writes.length = 0;
	const held = arm();
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
	const { during, adapt, arm } = interceptingFileOperations();
	const todos = await open(adapt);
	await todos.folder.files.create('notes.txt', 'saved');
	await todos.refresh();
	await todos.open('notes.txt');
	const editor = textEditor(todos);

	during.writes.length = 0;
	const held = arm();
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
	const { during, adapt, arm } = interceptingFileOperations();
	const todos = await open(adapt);
	for (const path of ['a.txt', 'b.txt', 'other.txt'])
		await todos.folder.files.create(path, path);
	await todos.refresh();
	await todos.open('a.txt');
	const editor = textEditor(todos);

	during.writes.length = 0;
	const held = arm();
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
	const original = (await text(todos, path))!;
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
	editor.change({ body: 'typed during\n' });
	// The save is held: it writes nothing, at either path.
	expect(await editor.save()).toBeUndefined();
	await Bun.sleep(450);
	expect(editor.state.isDirty).toBe(true);
	expect(await text(todos, 'todos/oat.md')).toBe(original);
	expect(await text(todos, path)).toBeUndefined();

	release();
	expect(await renaming).toBeUndefined();
	expect(todos.selectedPath).toBe('todos/oat.md');
	expect(todoEditor(todos)).toBe(editor);
	expect(editor.path).toBe('todos/oat.md');
	expect(editor.state.document.body).toBe('typed during\n');
	// The same-stem image did not move with the row.
	expect(await bytes(todos, image)).toEqual(new Uint8Array([7]));
	expect(await bytes(todos, 'todos/oat.png')).toBeUndefined();
	await editor.save();
	expect((await reading(todos, 'todos/oat.md')).body).toBe('typed during\n');
	expect(await text(todos, path)).toBeUndefined();
	expect(await todos.toggle(todos.entries[0]!)).toBeUndefined();
	expect(editor.state.document.fields.done).toBe(true);
	expect(await text(todos, path)).toBeUndefined();
});

test('a rename whose destination does not open as fields keeps the typing in the row source editor, and writes nothing at the old path', async () => {
	const todos = await open();
	await todos.create('Milk');
	const path = todos.selectedPath!;
	const editor = todoEditor(todos);
	const table = todos.folder.tables.todos;
	const rename = table.rename.bind(table);
	let release: (() => void) | undefined;
	// Another program rewrites the moved file as text that is not a valid todo
	// before the todo editor reopens there.
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
	editor.change({ body: 'typed during\n' });
	const invalid = '---\ntitle: Oat\ndone: soon\n---\n';
	expectOk(await todos.folder.files.overwrite('todos/oat.md', invalid));
	release();
	expect(await renaming).toBeUndefined();

	expect(todos.selectedPath).toBe('todos/oat.md');
	const source = sourceEditor(todos);
	expect(source.editor.path).toBe('todos/oat.md');
	// The typing is kept as the text the todo editor would have saved.
	expect(source.editor.buffer).toContain('typed during');
	expect(source.editor.dirty).toBe(true);
	expect(editor.state.isDisposed).toBe(true);

	// Its save is checked against the moved row, so the other writer is reviewed.
	await source.editor.save();
	expect(source.editor.saveState).toMatchObject({
		kind: 'conflict',
		current: { path: 'todos/oat.md', source: invalid },
	});
	expect(await text(todos, path)).toBeUndefined();
	await source.editor.keepMine();
	expect((await reading(todos, 'todos/oat.md')).body).toBe('typed during\n');
	expect(await text(todos, path)).toBeUndefined();
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
	const { during, adapt, arm } = interceptingFileOperations();
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
	const held = arm();
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

/** Why a move's source stayed: the second of its two steps failed. */
const sourceKept = (from: string) =>
	FileError.Io({
		path: from,
		operation: 'remove',
		cause: new Error('disk unplugged'),
	}).error;

test('a rename that lands its destination but keeps its source names both paths, keeps the input at the source, and neither retries nor deletes', async () => {
	const { during, adapt } = interceptingFileOperations();
	const todos = await open(adapt);
	await todos.folder.files.create('notes.txt', 'saved');
	await todos.refresh();
	await todos.open('notes.txt');
	const editor = textEditor(todos);

	// The move's first step lands: the destination holds the captured bytes.
	// Its second step, removing the source, fails.
	during.refuse = async (from, to) => {
		const captured = expectOk(await todos.folder.files.read(from));
		const moved = expectOk(await todos.folder.files.create(to, captured.bytes));
		return MoveError.SourceNotRemoved({
			from,
			to,
			moved,
			cause: sourceKept(from),
		});
	};
	during.act = () => editor.input('typed during');
	const problem = await todos.rename('notes.txt', 'renamed.txt');
	during.act = undefined;
	// The answer says where the file is now, not that nothing moved.
	expect(problem).toContain('renamed.txt');
	expect(problem).toContain('notes.txt');
	expect(problem).toContain('disk unplugged');
	expect(problem).not.toContain('Nothing was changed');
	expect(await text(todos, 'renamed.txt')).toBe('saved');
	expect(await text(todos, 'notes.txt')).toBe('saved');
	const listed = todos.listing?.files.map((file) => file.path);
	expect(listed).toContain('renamed.txt');
	expect(listed).toContain('notes.txt');

	// The input stays with the source, which still holds the file.
	expect(editor.path).toBe('notes.txt');
	expect(editor.buffer).toBe('typed during');
	expect(editor.saveState).toEqual({ kind: 'saved' });
	expect(todos.selectedPath).toBe('notes.txt');
	expect(textEditor(todos)).toBe(editor);

	// The held input saves against the unchanged baseline; nothing is moved
	// again, and the copy at the destination is left as it landed.
	during.writes.length = 0;
	await editor.save();
	expect(during.moves).toBe(1);
	expect(during.writes).toEqual(['notes.txt']);
	expect(await text(todos, 'notes.txt')).toBe('typed during');
	expect(await text(todos, 'renamed.txt')).toBe('saved');
});

test('a todo rename that lands its new path but keeps its old one leaves both rows, and the draft saves at the old path', async () => {
	const todos = await open();
	await todos.create('Milk');
	const path = todos.selectedPath!;
	const editor = todoEditor(todos);
	const original = (await text(todos, path))!;
	const table = todos.folder.tables.todos;
	const rename = table.rename;
	table.rename = async (capture, nextStem) => {
		const to = `todos/${nextStem}.md`;
		const moved = expectOk(await todos.folder.files.create(to, capture.source));
		editor.change({ body: 'typed during\n' });
		return MoveError.SourceNotRemoved({
			from: capture.path,
			to,
			moved,
			cause: sourceKept(capture.path),
		});
	};

	let problem: string | undefined;
	try {
		problem = await todos.rename(path, 'oat.md');
	} finally {
		table.rename = rename;
	}
	expect(problem).toContain('todos/oat.md');
	expect(problem).toContain(path);
	expect(todos.entries.map((entry) => entry.path).sort()).toEqual(
		[path, 'todos/oat.md'].sort(),
	);
	expect(todos.selectedPath).toBe(path);
	expect(todoEditor(todos)).toBe(editor);
	expect(editor.path).toBe(path);
	expect(editor.halt).toBeUndefined();
	expect(editor.state.document.body).toBe('typed during\n');

	expect(await editor.settle()).toBe(true);
	expect((await reading(todos, path)).body).toBe('typed during\n');
	expect(await text(todos, 'todos/oat.md')).toBe(original);
});

test('a todo rename whose reply was lost halts autosave and keeps the input until the person saves', async () => {
	const todos = await open();
	await todos.create('Milk');
	const path = todos.selectedPath!;
	const editor = todoEditor(todos);
	const original = (await text(todos, path))!;
	const table = todos.folder.tables.todos;
	const rename = table.rename.bind(table);
	// The move lands, but its reply never arrives.
	table.rename = async (capture, nextStem) => {
		expectOk(await rename(capture, nextStem));
		editor.change({ body: 'typed during\n' });
		return FileError.Unconfirmed({
			path: capture.path,
			operation: 'move',
			cause: new Error('the reply was lost'),
		});
	};

	let problem: string | undefined;
	try {
		problem = await todos.rename(path, 'oat.md');
	} finally {
		table.rename = rename;
	}
	expect(problem).toContain('may or may not');
	expect(editor.path).toBe(path);
	expect(editor.halt).toMatchObject({ kind: 'unknown', operation: 'rename' });
	expect(editor.state.document.body).toBe('typed during\n');
	expect(todos.saveProblems).toBe(1);
	// Autosave does not write the row back at the path it may have left.
	await Bun.sleep(450);
	expect(await text(todos, path)).toBeUndefined();
	expect(await text(todos, 'todos/oat.md')).toBe(original);
	expect(await editor.settle()).toBe(false);

	// Saving is the person's explicit choice, and writes where this editor is.
	expect(await editor.save()).toBeUndefined();
	expect(editor.halt).toBeUndefined();
	expect((await reading(todos, path)).body).toBe('typed during\n');
	expect(await text(todos, 'todos/oat.md')).toBe(original);
});

test("a row's source editor settles before table rename and delete, and refuses both while its save conflicts", async () => {
	const todos = await open();
	await todos.folder.files.create('todos/milk.md', ROW);
	await todos.refresh();
	await todos.open('todos/milk.md');
	expect(todoEditor(todos).path).toBe('todos/milk.md');
	await todos.folder.files.create('todos/milk.png', new Uint8Array([7]));

	// The source editor starts from the file's exact text.
	expect(await todos.editSource('todos/milk.md')).toBeUndefined();
	await reselect(todos, 'todos/milk.md');
	const { editor } = sourceEditor(todos);
	expect(editor.buffer).toBe(ROW);
	// A toggle does not reach around the source editor that owns the row.
	expect(await todos.toggle(todos.entries[0]!)).toContain('source editor');
	expect(await text(todos, 'todos/milk.md')).toBe(ROW);

	// A draft that cannot save refuses both operations and is kept.
	await todos.folder.files.overwrite('todos/milk.md', `${ROW}theirs\n`);
	editor.input(`${ROW}mine\n`);
	expect(await todos.rename('todos/milk.md', 'oat.md')).toBe(UNSETTLED);
	expect((await todos.deletionFor('todos/milk.md')).error).toBe(UNSETTLED);
	expect(await text(todos, 'todos/milk.md')).toBe(`${ROW}theirs\n`);
	await editor.keepMine();

	// The settled source editor moves with the row and keeps its exact text.
	editor.input(`${ROW}mine again\n`);
	expect(await todos.rename('todos/milk.md', 'oat.md')).toBeUndefined();
	expect(await text(todos, 'todos/oat.md')).toBe(`${ROW}mine again\n`);
	expect(await text(todos, 'todos/milk.md')).toBeUndefined();
	// The table rename moved the row alone; the image kept its name.
	expect(await bytes(todos, 'todos/milk.png')).toEqual(new Uint8Array([7]));
	expect(await bytes(todos, 'todos/oat.png')).toBeUndefined();
	expect(todos.selectedPath).toBe('todos/oat.md');
	expect(sourceEditor(todos).editor).toBe(editor);
	await todos.folder.files.create('todos/oat.webm', new Uint8Array([9]));

	editor.input(`${ROW}last\n`);
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

test('a todo editor settles before table rename and delete, and refuses both while its fields do not conform', async () => {
	const todos = await open();
	await todos.create('Milk');
	const path = todos.selectedPath!;
	const stem = await addSiblings(todos, path);
	const editor = todoEditor(todos);

	editor.change({ fields: { done: 'soon' } });
	expect(await todos.rename(path, 'oat.md')).toBe(UNSETTLED);
	expect((await todos.deletionFor(path)).error).toBe(UNSETTLED);
	expect(editor.state.document.fields.done).toBe('soon');
	expect((await reading(todos, path)).fields.done).toBe(false);

	// Fixed, the draft saves before the rename moves the row.
	editor.change({ fields: { done: true } });
	editor.change({ body: 'notes\n' });
	expect(await todos.rename(path, 'oat.md')).toBeUndefined();
	expect((await reading(todos, 'todos/oat.md')).fields.done).toBe(true);
	expect(todoEditor(todos)).toBe(editor);

	// Pending input saves before the deletion is captured.
	editor.change({ body: 'last\n' });
	const deletion = expectOk(await todos.deletionFor('todos/oat.md'));
	expect(deletion).toMatchObject({
		kind: 'todo',
		entry: { path: 'todos/oat.md', body: 'last\n' },
	});
	expect(await todos.remove(deletion)).toBeUndefined();
	expect(await text(todos, 'todos/oat.md')).toBeUndefined();
	await expectSiblings(todos, stem);
	expect(editor.state.isDisposed).toBe(true);
	expect(todos.selection).toBeUndefined();
	expect(todos.unsaved).toBe(false);
});

test('a row the todo editor refuses opens in its source editor with the reason, and opens as fields once repaired', async () => {
	const todos = await open();
	const broken = '---\ntitle: Bad\ndone: soon\n---\n';
	const aliased = '---\ntitle: *missing\ndone: false\n---\n';
	const unsupported =
		'---\ntitle: Big\ndone: false\nsize: 9007199254740993\n---\n';
	expectOk(await todos.folder.files.create('todos/bad.md', broken));
	expectOk(await todos.folder.files.create('todos/alias.md', aliased));
	expectOk(await todos.folder.files.create('todos/big.md', unsupported));
	await todos.refresh();

	// A field issue shows on the text itself; nothing else is said.
	await todos.open('todos/bad.md');
	const bad = sourceEditor(todos);
	expect(bad.editor.buffer).toBe(broken);
	expect(bad.reason).toBeUndefined();
	const listed = todos.entries.find((entry) => entry.path === 'todos/bad.md')!;
	expect(await todos.toggle(listed)).toContain('no readable done value');
	expect(await todos.editFields('todos/bad.md')).toContain('needs repair');

	// Text with no canonical form says why, whether or not it parses.
	await todos.open('todos/alias.md');
	expect(sourceEditor(todos).reason).toContain('no anchor');
	await todos.open('todos/big.md');
	expect(sourceEditor(todos).reason).toContain('safe range');

	// A repair saves exactly as typed, then the row opens as fields.
	await todos.open('todos/bad.md');
	bad.editor.input('---\ntitle: Fixed\ndone: false\n---\n');
	expect(await todos.editFields('todos/bad.md')).toBeUndefined();
	await reselect(todos, 'todos/bad.md');
	expect(await text(todos, 'todos/bad.md')).toBe(
		'---\ntitle: Fixed\ndone: false\n---\n',
	);
	expect(todoEditor(todos).state.document.fields).toEqual({
		title: 'Fixed',
		done: false,
	});
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
	const storage = testBrowserStorage({ BroadcastChannel });
	const handle = async () =>
		expectOk(
			await openFolder({
				id,
				definition: todosDefinition,
				browser: {
					author: { name: 'Test', email: 'test@example.test' },
					commitOnEdit: false,
					...storage,
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

/** A dirty todo draft, and another tab with a handle on the same folder. */
async function dirtyTodoWithAnotherTab() {
	const { todos, other } = await openWithAnotherTab();
	await todos.create('Milk');
	const path = todos.selectedPath!;
	const editor = todoEditor(todos);
	editor.change({ body: 'mine\n' });
	return { todos, other, path, editor };
}

/** Longer than the typing batch, so an autosave that was going to run has run. */
const pastTypingBatch = () => Bun.sleep(450);

test("another tab's change holds a dirty todo draft: autosave writes nothing, and only an explicit save replaces theirs with the whole draft", async () => {
	const { todos, other, path, editor } = await dirtyTodoWithAnotherTab();
	try {
		expectOk(
			await other.tables.todos.update(todos.entries[0]!.stem, {
				fields: { title: 'Oat milk', done: true },
				body: 'theirs\n',
			}),
		);
		await eventually(() => editor.isAwaitingReview);
		const theirs = await text(todos, path);

		// The implicit autosave does not run over what the person has not seen.
		await pastTypingBatch();
		expect(editor.isAwaitingReview).toBe(true);
		expect(editor.externalChange?.kind).toBe('present');
		expect(await text(todos, path)).toBe(theirs);
		expect(await reading(todos, path)).toMatchObject({
			fields: { title: 'Oat milk', done: true },
			body: 'theirs\n',
		});
		expect(editor.state.document).toEqual({
			fields: { title: 'Milk', done: false },
			body: 'mine\n',
		});
		expect(todos.unsaved).toBe(true);
		expect(todos.saveProblems).toBe(1);

		// More typing, settle, rename, delete, and a list toggle write nothing.
		editor.change({ body: 'mine and more\n' });
		await pastTypingBatch();
		expect(await editor.settle()).toBe(false);
		expect(await todos.rename(path, 'oat.md')).toBe(UNSETTLED);
		expect((await todos.deletionFor(path)).error).toBe(UNSETTLED);
		expect(await todos.toggle(todos.entries[0]!)).toContain(
			'changed elsewhere',
		);
		expect(await text(todos, path)).toBe(theirs);

		// The person's explicit save writes the whole local draft over theirs.
		expect(await editor.save()).toBeUndefined();
		expect(await reading(todos, path)).toMatchObject({
			fields: { title: 'Milk', done: false },
			body: 'mine and more\n',
		});
		expect(editor.isAwaitingReview).toBe(false);

		// The choice is made: later typing autosaves again.
		editor.change({ body: 'later\n' });
		await eventually(() => editor.isIdle);
		expect((await reading(todos, path)).body).toBe('later\n');
	} finally {
		await other.close();
	}
});

test("discarding mine after another tab changed the row loads their version into the todo's controls and writes nothing", async () => {
	const { todos, other, path, editor } = await dirtyTodoWithAnotherTab();
	try {
		expectOk(
			await other.tables.todos.update(todos.entries[0]!.stem, {
				fields: { title: 'Oat milk', done: true },
				body: 'theirs\n',
			}),
		);
		await eventually(() => editor.isAwaitingReview);
		const theirs = await text(todos, path);

		expect(editor.adopt()).toBeUndefined();
		// The values the title, done, and notes controls are bound to.
		expect(editor.state.document).toEqual({
			fields: { title: 'Oat milk', done: true },
			body: 'theirs\n',
		});
		expect(editor.isIdle).toBe(true);
		expect(editor.externalChange).toBeUndefined();
		await pastTypingBatch();
		expect(await text(todos, path)).toBe(theirs);
	} finally {
		await other.close();
	}
});

test('a dirty todo whose row another tab removed keeps its draft until the person chooses, and an explicit save writes it again', async () => {
	const { todos, other, path, editor } = await dirtyTodoWithAnotherTab();
	try {
		expectOk(await other.files.remove(expectOk(await other.files.read(path))));
		await eventually(() => editor.externalChange?.kind === 'missing');

		await pastTypingBatch();
		await todos.refresh();
		expect(await text(todos, path)).toBeUndefined();
		expect(todoEditor(todos)).toBe(editor);
		expect(editor.isAwaitingReview).toBe(true);
		expect(editor.state.document.body).toBe('mine\n');
		expect(await editor.settle()).toBe(false);
		expect(await text(todos, path)).toBeUndefined();

		expect(await editor.save()).toBeUndefined();
		expect(await text(todos, path)).toBe(editor.state.source);
		expect(editor.isAwaitingReview).toBe(false);
	} finally {
		await other.close();
	}
});

test('a dirty todo whose row another tab made malformed is held, and discarding it opens the malformed text for raw review', async () => {
	const { todos, other, path, editor } = await dirtyTodoWithAnotherTab();
	try {
		const malformed = '---\ntitle: *missing\ndone: false\n---\ntheirs\n';
		expectOk(await other.files.overwrite(path, malformed));
		await eventually(() => editor.externalChange?.kind === 'unsupported');

		await pastTypingBatch();
		expect(editor.isAwaitingReview).toBe(true);
		expect(await text(todos, path)).toBe(malformed);

		await todos.discard(path);
		expect(todos.selectedPath).toBe(path);
		const source = sourceEditor(todos);
		expect(source.editor.buffer).toBe(malformed);
		expect(source.reason).toContain('no anchor');
		expect(editor.state.isDisposed).toBe(true);
		expect(await text(todos, path)).toBe(malformed);
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

// ============================================================================
// Own deletes
// ============================================================================

/**
 * The app over one handle, and a second handle on the same storage with no
 * channel between them: what the second one writes really lands, and the
 * app's handle, its row editors included, hears nothing of it.
 */
async function openWithSilentHandle() {
	const id = `todos-test-${count++}`;
	// One storage for both handles, with no channel between them.
	const storage = testBrowserStorage();
	const handle = async () =>
		expectOk(
			await openFolder({
				id,
				definition: todosDefinition,
				browser: {
					author: { name: 'Test', email: 'test@example.test' },
					commitOnEdit: false,
					...storage,
				},
			}),
		);
	const todos = createTodos(await handle());
	opened.push(todos);
	await todos.refreshAll();
	return { todos, other: await handle() };
}

const lostReply = (path: string) =>
	FileError.Unconfirmed({
		path,
		operation: 'remove',
		cause: new Error('the reply was lost'),
	});

test('an own delete whose reply was lost after it landed holds the open todo: typing during it is kept, and nothing writes the row again', async () => {
	const { todos, other } = await openWithSilentHandle();
	try {
		await todos.create('Milk');
		const path = todos.selectedPath!;
		const editor = todoEditor(todos);
		const deletion = expectOk(await todos.deletionFor(path));
		const table = todos.folder.tables.todos;
		const remove = table.delete;
		// The delete lands where this app hears nothing of it, and typing
		// arrives before its reply, which is lost.
		table.delete = async (capture) => {
			expectOk(await other.tables.todos.delete(capture));
			editor.change({ body: 'typed during\n' });
			return lostReply(path);
		};
		let problem: string | undefined;
		try {
			problem = await todos.remove(deletion);
		} finally {
			table.delete = remove;
		}
		expect(problem).toContain('may or may not');
		expect(await text(todos, path)).toBeUndefined();
		expect(editor.halt).toMatchObject({ kind: 'unknown', operation: 'delete' });
		expect(editor.state.document.body).toBe('typed during\n');
		// The editor heard nothing: its latest read is still the row it deleted.
		expect(editor.state.observation.kind).toBe('present');

		// Past the typing pause, through a refresh that lists the row as gone,
		// and more typing, nothing writes the row back.
		await Bun.sleep(650);
		await todos.refresh();
		editor.change({ body: 'typed after\n' });
		await Bun.sleep(450);
		expect(await text(todos, path)).toBeUndefined();
		expect(todos.selectedPath).toBe(path);
		expect(todoEditor(todos)).toBe(editor);

		// No read answers the delete, not even one that finds the row gone.
		await editor.refresh();
		expect(editor.state.observation.kind).toBe('missing');
		expect(editor.halt).toMatchObject({ kind: 'unknown', operation: 'delete' });
		expect(await editor.settle()).toBe(false);
		expect(await todos.rename(path, 'oat.md')).toBe(UNSETTLED);
		expect((await todos.deletionFor(path)).error).toBe(UNSETTLED);
		expect(await todos.editSource(path)).toBe(UNSETTLED);
		expect(todos.unsaved).toBe(true);
		expect(todos.saveProblems).toBe(1);
		expect(await text(todos, path)).toBeUndefined();

		// Closing writes nothing either.
		await close(todos);
		expect((await other.files.read(path)).error?.name).toBe('NotFound');
		expect(editor.state.document.body).toBe('typed after\n');
	} finally {
		await other.close();
	}
});

test('an own delete whose reply was lost before it landed holds the clean todo: new typing waits, a toggle is refused, and only an explicit save writes', async () => {
	const todos = await open();
	await todos.create('Milk');
	const path = todos.selectedPath!;
	const editor = todoEditor(todos);
	const saved = await text(todos, path);
	const deletion = expectOk(await todos.deletionFor(path));
	const table = todos.folder.tables.todos;
	const remove = table.delete;
	// Nothing is removed, and the reply is lost.
	table.delete = async () => lostReply(path);
	try {
		expect(await todos.remove(deletion)).toContain('may or may not');
	} finally {
		table.delete = remove;
	}

	// Clean, the editor stays open and held all the same.
	expect(editor.state.isDirty).toBe(false);
	expect(editor.isIdle).toBe(false);
	expect(editor.halt).toMatchObject({ kind: 'unknown', operation: 'delete' });
	await todos.refresh();
	expect(todos.selectedPath).toBe(path);
	editor.change({ body: 'new typing\n' });
	await Bun.sleep(450);
	expect(await todos.toggle(todos.entries[0]!)).toContain('not settled');
	// A read that finds the row as it was does not answer the delete.
	await editor.refresh();
	expect(editor.halt).toMatchObject({ kind: 'unknown', operation: 'delete' });
	expect(await text(todos, path)).toBe(saved);

	// The person's explicit save writes the whole draft and ends the hold.
	expect(await editor.save()).toBeUndefined();
	expect(editor.halt).toBeUndefined();
	expect((await reading(todos, path)).body).toBe('new typing\n');
	editor.change({ body: 'later\n' });
	await eventually(() => editor.isIdle);
	expect((await reading(todos, path)).body).toBe('later\n');
});

test('a clean todo whose own delete went unanswered stays open until the person closes it, and closing it writes nothing', async () => {
	const todos = await open();
	await todos.create('Milk');
	const path = todos.selectedPath!;
	const editor = todoEditor(todos);
	const deletion = expectOk(await todos.deletionFor(path));
	const table = todos.folder.tables.todos;
	const remove = table.delete;
	// The delete lands, and the reply is lost.
	table.delete = async (capture) => {
		expectOk(await remove(capture));
		return lostReply(path);
	};
	try {
		expect(await todos.remove(deletion)).toContain('may or may not');
	} finally {
		table.delete = remove;
	}

	await editor.refresh();
	await todos.refresh();
	// The row's absence does not settle the delete, and the clean editor stays.
	expect(editor.state.observation.kind).toBe('missing');
	expect(editor.halt).toMatchObject({ kind: 'unknown', operation: 'delete' });
	expect(editor.isDiscardable).toBe(true);
	expect(todos.selectedPath).toBe(path);
	expect(todoEditor(todos)).toBe(editor);
	await Bun.sleep(450);
	expect(await text(todos, path)).toBeUndefined();

	await todos.discard(path);
	expect(todos.selectedPath).toBeUndefined();
	expect(todos.selection).toBeUndefined();
	expect(editor.state.isDisposed).toBe(true);
	expect(await text(todos, path)).toBeUndefined();
});

test('typing during an own delete that removed the row is kept and never writes it back on its own; an explicit save writes it again', async () => {
	const { todos, other } = await openWithSilentHandle();
	try {
		await todos.create('Milk');
		const path = todos.selectedPath!;
		const editor = todoEditor(todos);
		const deletion = expectOk(await todos.deletionFor(path));
		const table = todos.folder.tables.todos;
		const remove = table.delete;
		table.delete = async (capture) => {
			const removed = await other.tables.todos.delete(capture);
			editor.change({ body: 'typed during\n' });
			return removed;
		};
		try {
			expect(await todos.remove(deletion)).toBeUndefined();
		} finally {
			table.delete = remove;
		}
		expect(editor.halt).toMatchObject({ kind: 'deleted', operation: 'delete' });
		expect(editor.state.observation.kind).toBe('present');

		await Bun.sleep(650);
		await todos.refresh();
		expect(await text(todos, path)).toBeUndefined();
		expect(todoEditor(todos)).toBe(editor);
		expect(editor.state.document.body).toBe('typed during\n');

		// The person's choice writes the row again, whole.
		expect(await editor.save()).toBeUndefined();
		expect(editor.halt).toBeUndefined();
		expect(await text(todos, path)).toBe(editor.state.source);
		expect((await reading(todos, path)).body).toBe('typed during\n');
	} finally {
		await other.close();
	}
});

test('a raw file whose own delete reply was lost holds its draft, and no refresh, settle, or close sends it', async () => {
	const { during, adapt } = interceptingFileOperations();
	let lose = false;
	const todos = await open((folder) => {
		const adapted = adapt(folder);
		return {
			...adapted,
			files: {
				...adapted.files,
				async remove(file) {
					const removed = await adapted.files.remove(file);
					return lose && removed.error === null
						? lostReply(file.path)
						: removed;
				},
			},
		};
	});
	await todos.folder.files.create('notes.txt', 'saved');
	await todos.refresh();
	await todos.open('notes.txt');
	const editor = textEditor(todos);
	const deletion = expectOk(await todos.deletionFor('notes.txt'));

	// The delete lands, typing arrives, and the reply is lost.
	lose = true;
	during.act = () => editor.input('typed during');
	during.writes.length = 0;
	expect(await todos.remove(deletion)).toContain('may or may not');
	during.act = undefined;
	expect(editor.saveState).toEqual({ kind: 'unknown', operation: 'delete' });
	await Bun.sleep(450);
	await todos.refresh();
	expect(textEditor(todos)).toBe(editor);
	expect(await editor.settle()).toBe(false);
	expect(await todos.rename('notes.txt', 'other.txt')).toBe(UNSETTLED);

	await close(todos);
	expect(during.writes).toEqual([]);
	expect(editor.buffer).toBe('typed during');
});

test("a delete confirmed while its todo's own save is running waits for that save, and the delete then removes nothing it did not capture", async () => {
	const todos = await open();
	const table = todos.folder.tables.todos;
	const edit = table.edit;
	const started = Promise.withResolvers<void>();
	const reply = Promise.withResolvers<void>();
	let holdNext = false;
	// The editor's real save runs; only its reply is held, once.
	table.edit = async (...args) => {
		const opened = await edit(...args);
		if (opened.error !== null) return opened;
		const row = opened.data;
		return Ok({
			...row,
			async save() {
				const saved = row.save();
				if (holdNext) {
					holdNext = false;
					started.resolve();
					await reply.promise;
				}
				return saved;
			},
		});
	};
	await todos.create('Milk');
	const path = todos.selectedPath!;
	const editor = todoEditor(todos);
	const deletion = expectOk(await todos.deletionFor(path));

	holdNext = true;
	editor.change({ body: 'mine\n' });
	await started.promise;
	let answered = false;
	const removing = todos.remove(deletion).then((problem) => {
		answered = true;
		return problem;
	});
	await Bun.sleep(20);
	expect(answered).toBe(false);

	reply.resolve();
	// The save landed first, so the confirmed version is no longer there.
	expect(await removing).toContain('different content now');
	expect((await reading(todos, path)).body).toBe('mine\n');
	expect(todoEditor(todos)).toBe(editor);
	expect(editor.halt).toBeUndefined();
	expect(editor.isIdle).toBe(true);
	table.edit = edit;
});

// ============================================================================
// Closing
// ============================================================================

/**
 * A folder that names every file, table, Git, and terminal call the app makes
 * in `calls`, and sends no hints unless `hints` is set. Arming the gate holds
 * the next finished raw read or listing reply until the test releases it.
 */
function recordingFolder({ hints = false } = {}) {
	const calls: string[] = [];
	const gate = createGate();
	function recorded<T extends object>(name: string, target: T): T {
		const copy = { ...target } as Record<string, unknown>;
		for (const [key, value] of Object.entries(target))
			if (typeof value === 'function')
				copy[key] = (...args: unknown[]) => {
					calls.push(`${name}.${key}`);
					return value.apply(target, args);
				};
		return copy as T;
	}
	const adapt = (folder: TodosFolder): TodosFolder => {
		const files = recorded('files', folder.files);
		return {
			...(hints ? folder : withoutHints(folder)),
			files: {
				...files,
				read: async (path) => gate.reply(await files.read(path)),
				list: async () => gate.reply(await files.list()),
			},
			tables: { todos: recorded('table', folder.tables.todos) },
			git: {
				...recorded('git', folder.git),
				get snapshot() {
					return folder.git.snapshot;
				},
			},
			terminal(options) {
				const terminal = folder.terminal(options);
				return {
					get cwd() {
						return terminal.cwd;
					},
					exec(command, options) {
						calls.push('terminal.exec');
						return terminal.exec(command, options);
					},
				};
			},
			close() {
				calls.push('close');
				return folder.close();
			},
		};
	};
	return { calls, adapt, arm: gate.arm };
}

/** Close now; `afterEach` then has nothing left to close. */
function close(todos: Todos) {
	opened.splice(opened.indexOf(todos), 1);
	return todos.close();
}

test('a raw open whose read answers after close retains no editor', async () => {
	const { adapt, arm } = recordingFolder();
	const todos = await open(adapt);
	expectOk(await todos.folder.files.create('notes.txt', 'saved'));

	const held = arm();
	const opening = todos.open('notes.txt');
	const release = await held();
	await close(todos);
	release();
	await opening;
	// `selection` is first read here; see `reselect`.
	expect(todos.selection).toBeUndefined();
});

test('a row open whose editor answers after close retains it nowhere and disposes it', async () => {
	const { adapt } = recordingFolder();
	const todos = await open(adapt);
	expectOk(await todos.folder.files.create('todos/late.md', ROW));
	const table = todos.folder.tables.todos;
	const edit = table.edit;
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let late: Awaited<ReturnType<typeof edit>> | undefined;
	table.edit = async (...args) => {
		late = await edit(...args);
		entered.resolve();
		await release.promise;
		return late;
	};

	const opening = todos.open('todos/late.md');
	await entered.promise;
	await close(todos);
	release.resolve();
	await opening;
	expect(todos.selection).toBeUndefined();
	expect(todos.entries).toEqual([]);
	expect(expectOk(late!).get().isDisposed).toBe(true);
});

test('a listing that answers after close changes neither the rows nor a clean editor', async () => {
	const { adapt, arm } = recordingFolder();
	const todos = await open(adapt);
	expectOk(await todos.folder.files.create('notes.txt', 'saved'));
	await todos.open('notes.txt');
	const editor = textEditor(todos);
	const listing = todos.listing;
	expectOk(await todos.folder.files.create('todos/late.md', ROW));
	expectOk(await todos.folder.files.overwrite('notes.txt', 'theirs'));

	const held = arm();
	const refreshing = todos.refresh();
	const release = await held();
	await close(todos);
	release();
	await refreshing;
	expect(todos.entries).toEqual([]);
	expect(todos.listing).toBe(listing);
	expect(editor.buffer).toBe('saved');
});

test('close waits for a create reply and retains no editor', async () => {
	const { calls, adapt } = recordingFolder();
	const todos = await open(adapt);
	const table = todos.folder.tables.todos;
	const create = table.create;
	let release: (() => void) | undefined;
	table.create = async (...args) => {
		const created = await create(...args);
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		return created;
	};

	const creating = todos.create('Milk');
	while (release === undefined) await Bun.sleep(1);
	const written = expectOk(await todos.folder.files.list()).files;
	expect(written.some((file) => ROW_PATH.test(file.path))).toBe(true);
	let closed = false;
	const closing = close(todos).then(() => {
		closed = true;
	});
	await Promise.resolve();
	expect(closed).toBe(false);
	expect(calls).not.toContain('close');
	release();
	await closing;
	expect(await creating).toBeUndefined();
	expect(todos.selection).toBeUndefined();
	expect(todos.selectedPath).toBeUndefined();
});

test('close waits for a held rename, which moves the file and opens nothing at the destination', async () => {
	const { adapt, arm } = interceptingFileOperations();
	const todos = await open(adapt);
	expectOk(await todos.folder.files.create('todos/note.txt', ROW));
	await todos.refresh();
	await todos.open('todos/note.txt');

	const held = arm();
	const renaming = todos.rename('todos/note.txt', 'note.md');
	const release = await held();
	expect(await text(todos, 'todos/note.md')).toBe(ROW);
	let closed = false;
	const closing = close(todos).then(() => {
		closed = true;
	});
	await Bun.sleep(5);
	expect(closed).toBe(false);

	release();
	expect(await renaming).toBeUndefined();
	await closing;
	// The clean raw editor gave way, and the row's todo editor never opens.
	expect(todos.selection).toBeUndefined();
	expect(todos.selectedPath).toBeUndefined();
});

test('a raw draft whose save reply was lost sends nothing more through rename, delete, or close', async () => {
	let replaces = 0;
	// The first save lands, but its reply never arrives.
	const todos = await open((folder) => ({
		...folder,
		files: {
			...folder.files,
			async replace(file, content) {
				replaces++;
				const replaced = await folder.files.replace(file, content);
				if (replaces > 1 || replaced.error !== null) return replaced;
				return FileError.Unconfirmed({
					path: file.path,
					operation: 'write',
					cause: new Error('the reply was lost'),
				});
			},
		},
	}));
	expectOk(await todos.folder.files.create('notes.txt', 'saved'));
	await todos.open('notes.txt');
	const editor = textEditor(todos);

	editor.input('mine');
	await editor.save();
	expect(editor.saveState).toEqual({ kind: 'unknown', operation: 'save' });
	expect(await text(todos, 'notes.txt')).toBe('mine');
	editor.input('mine and more');
	await Bun.sleep(450);
	expect(todos.unsaved).toBe(true);
	expect(todos.saveProblems).toBe(1);
	expect(await todos.rename('notes.txt', 'other.txt')).toBe(UNSETTLED);
	expect((await todos.deletionFor('notes.txt')).error).toBe(UNSETTLED);
	expect(replaces).toBe(1);
	expect(await text(todos, 'notes.txt')).toBe('mine');

	await close(todos);
	expect(replaces).toBe(1);
	expect(editor.buffer).toBe('mine and more');
});

test('every close call shares one completion, and the folder closes once', async () => {
	const { adapt, arm } = interceptingFileOperations();
	const recording = recordingFolder();
	let reentrant: Promise<void> | undefined;
	const todos: Todos = await open((folder) => {
		const adapted = recording.adapt(adapt(folder));
		return {
			...adapted,
			files: {
				...adapted.files,
				// The save that close settles calls close again from inside it.
				replace(file, content) {
					reentrant = todos.close();
					return adapted.files.replace(file, content);
				},
			},
		};
	});
	expectOk(await todos.folder.files.create('a.txt', 'saved'));
	expectOk(await todos.folder.files.create('notes.txt', 'saved'));
	await todos.open('notes.txt');
	textEditor(todos).input('typed');

	const held = arm();
	const renaming = todos.rename('a.txt', 'b.txt');
	const release = await held();
	const first = close(todos);
	// A call while the admitted rename is still held.
	expect(todos.close()).toBe(first);
	release();
	expect(await renaming).toBeUndefined();
	await first;
	expect(reentrant).toBe(first);
	expect(todos.close()).toBe(first);
	expect(recording.calls.filter((call) => call === 'close')).toEqual(['close']);
});

test('calls made after close began are refused without folder or terminal work', async () => {
	const { adapt, arm } = interceptingFileOperations();
	const recording = recordingFolder();
	const todos = await open((folder) => recording.adapt(adapt(folder)));
	expectOk(await todos.folder.files.create('a.txt', 'saved'));
	expectOk(await todos.folder.files.create('notes.txt', 'saved'));
	expect(await todos.create('Milk')).toBeUndefined();
	const entry = todos.entries[0]!;
	const deletion = expectOk(await todos.deletionFor('notes.txt'));

	// A held rename keeps close pending while the folder itself is still open.
	const held = arm();
	const renaming = todos.rename('a.txt', 'b.txt');
	const release = await held();
	const closing = close(todos);
	recording.calls.length = 0;

	await todos.open('notes.txt');
	await todos.refresh();
	await todos.refreshAll();
	expect(await todos.create('Bread')).toBe(CLOSING);
	expect(await todos.toggle(entry)).toBe(CLOSING);
	expect(await todos.rename('notes.txt', 'renamed.txt')).toBe(CLOSING);
	expect(await todos.createFile('', 'new.txt')).toBe(CLOSING);
	expect(await todos.createFolder('', 'docs')).toBe(CLOSING);
	expect((await todos.deletionFor('notes.txt')).error).toBe(CLOSING);
	expect(await todos.remove(deletion)).toBe(CLOSING);
	expect(await todos.commitAndPush()).toEqual({
		commit: { status: 'closed' },
		push: { status: 'closed' },
	});
	expect((await todos.pull()).error?.name).toBe('Closed');
	expect((await todos.merge()).error?.name).toBe('Closed');
	todos.terminal.command = 'touch shell.txt';
	await todos.terminal.run();
	expect(todos.terminal.runs.at(-1)?.result?.exitCode).toBe(1);
	expect(recording.calls).toEqual([]);
	expect(todos.selectedPath).toBe(entry.path);

	release();
	expect(await renaming).toBeUndefined();
	await closing;
	// The admitted rename finished without a listing; only the close followed.
	expect(recording.calls).toEqual(['close']);
});

test('a hinted listing still held when the app closes neither delays close nor changes state', async () => {
	const { calls, adapt, arm } = recordingFolder({ hints: true });
	const todos = await open(adapt);
	const { entries, listing } = todos;

	// The save hints, and the reread it starts lists the folder.
	const held = arm();
	expectOk(await todos.folder.files.create('todos/late.md', ROW));
	const release = await held();
	let closed = false;
	void close(todos).then(() => {
		closed = true;
	});
	await Bun.sleep(20);
	expect(closed).toBe(true);

	calls.length = 0;
	release();
	await Bun.sleep(5);
	expect(todos.entries).toBe(entries);
	expect(todos.listing).toBe(listing);
	expect(calls).toEqual([]);
});

test('a refresh stops reading open editors once a read closes the app', async () => {
	const recording = recordingFolder();
	const reads: string[] = [];
	let closeOnRead = false;
	const todos: Todos = await open((folder) => {
		const adapted = recording.adapt(folder);
		return {
			...adapted,
			files: {
				...adapted.files,
				read(path) {
					if (closeOnRead) {
						reads.push(path);
						void close(todos);
					}
					return adapted.files.read(path);
				},
			},
		};
	});
	const editors = [];
	for (const path of ['a.txt', 'b.txt']) {
		expectOk(await todos.folder.files.create(path, 'saved'));
		await todos.open(path);
		editors.push(textEditor(todos));
		expectOk(await todos.folder.files.overwrite(path, 'theirs'));
	}

	closeOnRead = true;
	await todos.refresh();
	expect(reads).toEqual(['a.txt']);
	expect(editors.map((editor) => editor.buffer)).toEqual(['saved', 'saved']);
});

test('a refresh reads no further editor once an observation closes the app', async () => {
	const recording = recordingFolder();
	const todos = await open(recording.adapt);
	for (const path of ['a.txt', 'b.txt'])
		expectOk(await todos.folder.files.create(path, 'saved'));
	await todos.open('a.txt');
	const first = textEditor(todos);
	await todos.open('b.txt');
	// The first editor's observation closes the app before the loop moves on.
	const observe = first.observe;
	first.observe = (next) => {
		observe(next);
		void todos.close();
	};

	recording.calls.length = 0;
	await todos.refresh();
	await close(todos);
	expect(recording.calls.filter((call) => call === 'files.read')).toEqual([
		'files.read',
	]);
});

test('close waits for folder creation and expands nothing', async () => {
	const { calls, adapt } = recordingFolder();
	const todos = await open(adapt);
	expect(await todos.createFolder('', 'docs')).toBeUndefined();
	const { files } = todos.folder;
	const mkdir = files.mkdir;
	let release: (() => void) | undefined;
	files.mkdir = async (path) => {
		const made = await mkdir(path);
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		return made;
	};

	const creating = todos.createFolder('docs', 'inner');
	while (release === undefined) await Bun.sleep(1);
	let closed = false;
	const closing = close(todos).then(() => {
		closed = true;
	});
	await Promise.resolve();
	expect(closed).toBe(false);
	expect(calls).not.toContain('close');
	release();
	await closing;
	expect(await creating).toBeUndefined();
	expect(todos.expanded.has('docs')).toBe(false);
});

test('a fetch that answers after close began does not start the fast-forward', async () => {
	const { calls, adapt } = recordingFolder();
	const todos = await open(adapt);
	const { git } = todos.folder;
	const fetch = git.fetch;
	let release: (() => void) | undefined;
	// This folder has no remote, so its real fetch refuses. The reply delivered
	// late in its place is the success a remote would have answered.
	git.fetch = async (options) => {
		await fetch(options);
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		return Ok({ status: 'fetched', oid: undefined });
	};

	const pulling = todos.pull();
	while (release === undefined) await Bun.sleep(1);
	await close(todos);
	calls.length = 0;
	release();
	expect((await pulling).error?.name).toBe('Closed');
	expect(calls).toEqual([]);
});

test('merge fetches, then merges what was fetched, and pushes nothing', async () => {
	const { calls, adapt } = recordingFolder();
	const todos = await open(adapt);
	const { git } = todos.folder;
	const merged = {
		status: 'merged' as const,
		from: 'a'.repeat(40),
		to: 'c'.repeat(40),
		fetched: 'b'.repeat(40),
		changedPaths: ['kv.json'],
	};
	git.fetch = async () => {
		calls.push('git.fetch');
		return Ok({ status: 'fetched', oid: merged.fetched });
	};
	git.mergeIncoming = async () => {
		calls.push('git.mergeIncoming');
		return Ok(merged);
	};
	calls.length = 0;
	expect(expectOk(await todos.merge())).toEqual(merged);
	expect(calls.filter((call) => call.startsWith('git.'))).toEqual([
		'git.fetch',
		'git.mergeIncoming',
	]);
});

test('where the folder cannot merge, merge fetches nothing and says why', async () => {
	const { calls, adapt } = recordingFolder();
	const todos = await open((folder) => {
		const adapted = adapt(folder);
		return {
			...adapted,
			git: {
				...adapted.git,
				mergeUnsupported: 'not in this place',
				get snapshot() {
					return folder.git.snapshot;
				},
			},
		};
	});
	calls.length = 0;
	expect((await todos.merge()).error).toMatchObject({
		name: 'Unsupported',
		reason: 'not in this place',
	});
	expect(calls).toEqual([]);
});

test('close cancels a pull whose fetch is still on the network, and nothing is fast-forwarded', async () => {
	const originalFetch = globalThis.fetch;
	let requests = 0;
	// The request ends only when the folder aborts it.
	globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
		requests++;
		return new Promise<Response>((_resolve, reject) =>
			init?.signal?.addEventListener('abort', () =>
				reject(new DOMException('The fetch was cancelled', 'AbortError')),
			),
		);
	}) as typeof fetch;
	try {
		const { calls, adapt } = recordingFolder();
		const todos = await open(adapt, {
			url: 'http://stall.test/remote.git',
			branch: 'main',
		});
		const pulling = todos.pull();
		for (let waited = 0; waited < 400 && requests === 0; waited++)
			await Bun.sleep(5);
		expect(requests).toBe(1);

		await close(todos);
		// The folder aborted the request: the refusal carries the abort's reason.
		expect((await pulling).error).toMatchObject({
			name: 'Failed',
			operation: 'fetch',
			message: 'Git fetch failed: The fetch was cancelled',
		});
		expect(requests).toBe(1);
		expect(calls).not.toContain('git.pullFastForward');
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('close waits for folder removal before releasing the folder', async () => {
	const { calls, adapt } = recordingFolder();
	const todos = await open(adapt);
	expect(await todos.createFolder('', 'docs')).toBeUndefined();
	const files = todos.folder.files;
	const rmdir = files.rmdir;
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	files.rmdir = async (path) => {
		started.resolve();
		await release.promise;
		return rmdir(path);
	};
	const removing = todos.remove({ kind: 'folder', path: 'docs' });
	await started.promise;
	const closing = close(todos);
	await Promise.resolve();
	expect(calls).not.toContain('close');
	release.resolve();
	expect(await removing).toBeUndefined();
	await closing;
	expect(calls).toContain('files.rmdir');
	expect(calls).toContain('close');
});
