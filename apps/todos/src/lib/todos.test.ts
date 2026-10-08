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
 * - A renamed open text file keeps its editor at the new path, including a
 *   file renamed into a todo row: it stays a plain editor in Files
 * - The surface a path is opened from decides its editor: Files opens any
 *   file's complete text, a todo's included, and the list opens a todo
 *   editor. Opening a path from the other surface hands it off: the editor
 *   there stops taking input at once, settles, and is let go before the new
 *   one opens. One whose input could not be saved stays, with that input,
 *   and nothing opens in its place. A let-go editor takes nothing more
 * - Whichever editor is open on a row settles before its table rename or delete
 * - An open todo's controls and a toggle from the list submit complete rows
 *   to its one native editor at once. A toggle while that editor's save runs
 *   queues behind it and proceeds after a lost reply. A toggle while Files
 *   holds the file assigns `done` in its plain editor's current text, which
 *   saves it; input that editor could not save is left alone. A toggle with no editor open assigns
 *   `done` in the row as it is now and keeps every other byte, and a write
 *   that lands between its read and its save refuses it
 * - A row that does not read as a todo is named for repair, with why,
 *   instead of listed. Files opens its exact text; repaired there, it is
 *   listed again and opens as a todo only when asked. An open todo whose row
 *   becomes invalid keeps its editor and text and says why
 * - A row whose filename breaks the naming rules, or is empty, is addressed
 *   by its literal stem: it toggles, saves over another writer, and renames
 *   to any literal name
 * - Each path keeps its own todo editor and input: switching between todos,
 *   rapidly or across a rename, never moves input from one to another
 * - A todo rename or delete fences its editor's input and waits for admitted
 *   writes; a failed write refuses both and its input stays. A renamed todo
 *   opens a new editor at the destination, whatever the destination's text,
 *   and nothing is written at the old path
 * - Typing that arrives during a raw rename or delete is kept, never forgotten
 * - A raw rename owns both paths until its editor is at the destination:
 *   saves wait for it, refreshes and opens leave its paths alone, and
 *   overlapping operations on either path are refused
 * - A rename never lands on an open editor, and a failed one keeps the input
 *   at the last accepted path without retrying. A move that landed its
 *   destination but kept its source leaves both files, names both paths, and
 *   removes neither; a todo move or delete whose reply was lost says so, and
 *   a later write of a row that is gone fails, recreating nothing
 * - A stale open or listing cannot replace or forget what is retained now
 * - A change hint from the folder rereads the listings without a refresh
 *   call, and a clean raw editor adopts the saved text. An open todo is read
 *   only when it opens or the person reloads it: another tab's change is
 *   replaced by the todo's next edit, and Reload shows it instead
 * - A failed todo save keeps its input; later edits save again;
 *   Reload replaces the input with the file, and closes a todo that is gone
 * - A todo row that cannot be saved changes nothing and keeps only why; it
 *   is not unsaved for leaving, rename, delete, or close
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
import {
	type CapturedMoveError,
	FileError,
	inspectRow,
	MoveError,
	openFolder,
} from '@epicenter/folder/browser';
import { withFileNewlines } from '@epicenter/folder/file-browser';
import { type Err, Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	browserStorage,
	createTestStorage,
	opfsOf,
	testBrowserStorage,
	testLocks,
} from '../../../../packages/folder/src/browser-storage.test-support.js';
import type {
	OpfsDirectoryHandle,
	OpfsFileHandle,
} from '../../../../packages/folder/src/opfs-store.js';
import { todosDefinition } from './definition.js';
import { holdCloses } from './opfs-holds.test-support.js';
import type { TodosFolder } from './platform/types.js';
import type { TodoEditor } from './todo-editor.svelte.js';
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
	await todos.check();
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

/** The plain editor the detail shows: a file Files opened as text. */
function textEditor(todos: Todos) {
	const current = todos.current;
	if (current?.workspace !== 'files' || current.item?.kind !== 'text')
		throw new Error(
			`Expected an open text file, got ${JSON.stringify(current)}`,
		);
	return current.item.editor;
}

/** The todo editor the detail shows: a row the list opened. */
function todoEditor(todos: Todos) {
	const current = todos.current;
	if (current?.workspace !== 'todos' || current.item?.kind !== 'todo')
		throw new Error(`Expected an open todo, got ${current?.item?.kind}`);
	return current.item.editor;
}

/** The path the detail shows. */
function shownPath(todos: Todos) {
	return todos.current?.path;
}

/** The text a todo editor holds: what it shows and writes. */
function accepted(editor: TodoEditor) {
	return editor.row.text;
}

/** Wait for a todo's admitted writes. Answers why the latest did not land. */
async function written(editor: TodoEditor) {
	await editor.settle();
	return editor.save.status === 'failed'
		? editor.save.error.message
		: undefined;
}

/** The fields view's current row; it shows only for a valid row. */
function fieldsOf(editor: TodoEditor) {
	const { row } = editor;
	if (row.status !== 'valid') throw new Error('The row shows no fields');
	return row;
}

/** What the title control sends: the complete row on screen with `title`. */
function typeTitle(editor: TodoEditor, title: string) {
	const row = fieldsOf(editor);
	return editor.set({ ...row, fields: { ...row.fields, title } });
}

/** What the notes control sends: the complete row on screen with `notes` in the file's newlines. */
function typeNotes(editor: TodoEditor, notes: string) {
	const row = fieldsOf(editor);
	return editor.set({ ...row, body: withFileNewlines(notes, row.text) });
}

/** What the done checkbox sends: the complete row on screen with `done`. */
function check(editor: TodoEditor, done: boolean) {
	const row = fieldsOf(editor);
	return editor.set({ ...row, fields: { ...row.fields, done } });
}

/** Wait for something the test did not request directly. The assertion follows the wait. */
async function eventually(settled: () => boolean) {
	for (let waited = 0; waited < 400 && !settled(); waited++) await Bun.sleep(5);
}

/** How a file reads as a todo now. */
async function reading(todos: Todos, path: string) {
	return inspectRow(
		todosDefinition.tables.todos,
		(await text(todos, path)) ?? '',
	);
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
	const path = shownPath(todos)!;
	const stem = await addSiblings(todos, path);
	await todos.refresh();

	const deletion = expectOk(await todos.deletionFor(path));
	expect(deletion).toMatchObject({ kind: 'todo', entry: { path } });
	expect(await todos.remove(deletion)).toBeUndefined();
	expect(await text(todos, path)).toBeUndefined();
	await expectSiblings(todos, stem);
	expect(shownPath(todos)).toBeUndefined();
	expect(todos.entries).toEqual([]);
	// The files that stayed are still listed and open as what they are.
	await todos.open(`${stem}.png`, 'files');
	expect(todos.current?.item).toMatchObject({
		kind: 'binary',
		size: PNG.byteLength,
	});
});

test('renaming a todo row moves only its Markdown file, and a new editor opens at the new path while same-stem files stay', async () => {
	const todos = await open();
	await todos.create('Milk');
	const path = shownPath(todos)!;
	const editor = todoEditor(todos);
	const source = (await text(todos, path))!;
	const stem = await addSiblings(todos, path);
	// Another row's editor and a sibling's raw editor are open and dirty.
	await todos.create('Bread');
	const otherPath = shownPath(todos)!;
	const other = todoEditor(todos);
	typeNotes(other, 'other typing\n');
	await todos.open(`${stem}.txt`, 'files');
	const sidecar = textEditor(todos);
	sidecar.input(`${SIDECAR}typed\n`);
	await todos.open(path, 'todos');

	expect(await todos.rename(path, 'renamed.md')).toBeUndefined();
	expect(await text(todos, 'todos/renamed.md')).toBe(source);
	expect(await text(todos, path)).toBeUndefined();
	await expectNoSiblings(todos, 'todos/renamed');
	expect(await bytes(todos, `${stem}.png`)).toEqual(PNG);
	expect(await bytes(todos, `${stem}.webm`)).toEqual(WEBM);

	// The renamed row has a new editor at the new path; the old one is fixed
	// to the path the row left and is no longer retained.
	expect(shownPath(todos)).toBe('todos/renamed.md');
	const renamed = todoEditor(todos);
	expect(renamed).not.toBe(editor);
	expect(renamed.path).toBe('todos/renamed.md');
	expect(editor.path).toBe(path);
	// The other editors were not retargeted and still save where they were.
	expect(other.path).toBe(otherPath);
	expect(sidecar.path).toBe(`${stem}.txt`);
	expect(await written(other)).toBeUndefined();
	await sidecar.save();
	expect(await text(todos, otherPath)).toContain('other typing');
	expect(await text(todos, `${stem}.txt`)).toBe(`${SIDECAR}typed\n`);
	expect(todos.unsaved).toBe(false);

	// Typing in the renamed todo saves at the new path only.
	typeNotes(renamed, 'after\n');
	expect(await written(renamed)).toBeUndefined();
	expect(await text(todos, 'todos/renamed.md')).toBe(accepted(renamed));
	expect((await reading(todos, 'todos/renamed.md')).body).toBe('after\n');
	expect(await text(todos, path)).toBeUndefined();
});

test('switching between todos keeps each input with its own path, rapidly and across a rename', async () => {
	const todos = await open();
	await todos.create('A');
	const pathA = shownPath(todos)!;
	await todos.create('B');
	const pathB = shownPath(todos)!;

	// Type into A, switch to B before A's write lands, and type there.
	await todos.open(pathA, 'todos');
	const a = todoEditor(todos);
	typeTitle(a, 'A typed');
	await todos.open(pathB, 'todos');
	const b = todoEditor(todos);
	expect(b).not.toBe(a);
	typeTitle(b, 'B typed');
	// Back and forth: each editor keeps its own input.
	await todos.open(pathA, 'todos');
	expect(todoEditor(todos)).toBe(a);
	expect(fieldsOf(a).fields.title).toBe('A typed');
	typeNotes(a, 'A notes\n');
	await todos.open(pathB, 'todos');
	expect(todoEditor(todos)).toBe(b);
	expect(fieldsOf(b).fields.title).toBe('B typed');
	expect(fieldsOf(b).body).toBe('');

	await eventually(() => a.isIdle && b.isIdle);
	expect(await reading(todos, pathA)).toMatchObject({
		fields: { title: 'A typed', done: false },
		body: 'A notes\n',
	});
	expect(await reading(todos, pathB)).toMatchObject({
		fields: { title: 'B typed', done: false },
		body: '',
	});

	// A rename reacquires A at its new path while B, selected, keeps its input.
	typeNotes(b, 'B pending\n');
	expect(await todos.rename(pathA, 'renamed-a.md')).toBeUndefined();
	expect(todoEditor(todos)).toBe(b);
	await todos.open('todos/renamed-a.md', 'todos');
	const movedA = todoEditor(todos);
	expect(movedA).not.toBe(a);
	expect(movedA.path).toBe('todos/renamed-a.md');
	typeTitle(movedA, 'A after');
	await todos.open(pathB, 'todos');
	expect(todoEditor(todos)).toBe(b);
	expect(fieldsOf(b).body).toBe('B pending\n');
	await todos.open('todos/renamed-a.md', 'todos');
	expect(todoEditor(todos)).toBe(movedA);
	expect(fieldsOf(movedA).fields.title).toBe('A after');
	await eventually(() => movedA.isIdle && b.isIdle);
	expect((await reading(todos, 'todos/renamed-a.md')).fields.title).toBe(
		'A after',
	);
	expect(await reading(todos, pathB)).toMatchObject({
		fields: { title: 'B typed' },
		body: 'B pending\n',
	});
	expect(await text(todos, pathA)).toBeUndefined();
});

// ============================================================================
// Retained input and stale observations
// ============================================================================

test('refresh forgets a removed idle todo, and keeps a removed todo whose write failed until deliberate Close', async () => {
	const todos = await open(withoutHints);
	await todos.create('Idle');
	const idlePath = shownPath(todos)!;
	await removeNow(todos, idlePath);
	await todos.refresh();
	expect(todos.current?.item).toBeUndefined();
	expect(todos.unsaved).toBe(false);

	await todos.create('Dirty');
	const path = shownPath(todos)!;
	const editor = todoEditor(todos);
	await removeNow(todos, path);
	// The todo still shows what it loaded; its write replaces only an existing row.
	typeNotes(editor, 'mine\n');
	expect(await written(editor)).toBeDefined();
	expect(editor.save).toMatchObject({
		status: 'failed',
		error: { name: 'NotFound' },
	});
	await todos.refresh();
	expect(todos.current?.item?.kind).toBe('todo');
	expect(fieldsOf(editor).body).toBe('mine\n');
	expect(todos.unsaved).toBe(true);
	expect(await text(todos, path)).toBeUndefined();

	// A failed Reload keeps input; only the explicit Close lets it go.
	expect(await todos.reload(path)).toContain('could not be read');
	expect(fieldsOf(editor).body).toBe('mine\n');
	expect(todos.unsaved).toBe(true);
	todos.discard(path);
	expect(shownPath(todos)).toBe(path);
	expect(todos.unsaved).toBe(false);
	expect(todos.saveProblems).toBe(0);
	expect(editor.isFenced).toBe(true);
	expect(await text(todos, path)).toBeUndefined();
});

/**
 * Todos over a browser folder whose next write of `path`, once armed, fails
 * before it publishes, with one todo, Milk, created and selected.
 */
async function openFailingNextWrite() {
	const storage = createTestStorage();
	const folder = expectOk(
		await openFolder({
			id: `todos-test-${count++}`,
			definition: todosDefinition,
			browser: {
				author: { name: 'Test', email: 'test@example.test' },
				commitOnEdit: false,
				...browserStorage(storage),
			},
		}),
	);
	const todos = createTodos(folder);
	opened.push(todos);
	await todos.check();
	await todos.create('Milk');
	const path = shownPath(todos)!;
	const { faults } = opfsOf(storage);
	const failNext = () => {
		faults.write = (file) => {
			if (!file.endsWith(`/${path}`)) return undefined;
			faults.write = undefined;
			return 'fail';
		};
	};
	return { todos, path, failNext, faults };
}

test("a todo's own saves reach the listings through the folder's hint, with no refresh asked, and when one save lands and the queued one fails, the list shows the landed one and the failed input stays without a retry", async () => {
	const { todos, path, faults } = await openFailingNextWrite();
	const editor = todoEditor(todos);
	const listed = () => todos.entries.find((entry) => entry.path === path);

	typeTitle(editor, 'Oat milk');
	expect(await written(editor)).toBeUndefined();
	await eventually(() => listed()?.fields.title === 'Oat milk');
	expect(listed()?.fields.title).toBe('Oat milk');

	// The first save holds as its file opens; the next input queues behind it
	// and fails when its turn comes.
	const opening = Promise.withResolvers<void>();
	let opens = 0;
	faults.open = async (file) => {
		if (!file.endsWith(`/${path}`)) return;
		opens += 1;
		if (opens === 1) await opening.promise;
	};
	faults.close = (file) =>
		file.endsWith(`/${path}`) && opens === 2 ? 'fail' : undefined;
	try {
		typeTitle(editor, 'Landed');
		const landed = accepted(editor);
		await eventually(() => opens === 1);
		typeTitle(editor, 'Queued');
		const queued = accepted(editor);
		opening.resolve();
		expect(await written(editor)).toBeDefined();

		await eventually(() => listed()?.text === landed);
		expect(listed()).toMatchObject({ text: landed });
		expect(await text(todos, path)).toBe(landed);
		expect(editor.save.status).toBe('failed');
		expect(editor.row.text).toBe(queued);
		// Nothing sends the failed input again: not the hint, not its reread.
		await Bun.sleep(20);
		expect(opens).toBe(2);
		expect(editor.save.status).toBe('failed');
		expect(editor.row.text).toBe(queued);
		expect(await text(todos, path)).toBe(landed);
	} finally {
		opening.resolve();
		faults.open = undefined;
		faults.close = undefined;
	}
});

test('a failed save keeps the input and later typing saves again; Reload replaces another failed edit', async () => {
	const { todos, path, failNext } = await openFailingNextWrite();
	const editor = todoEditor(todos);
	failNext();
	typeTitle(editor, 'Mine');
	expect(await written(editor)).toBeDefined();
	expect(editor.save.status).toBe('failed');
	expect(todos.saveProblems).toBe(1);

	// Newer typing is the todo's input and saves the complete row again.
	typeNotes(editor, 'later\n');
	expect(fieldsOf(editor).fields.title).toBe('Mine');
	expect(fieldsOf(editor).body).toBe('later\n');

	expect(await written(editor)).toBeUndefined();
	expect(await reading(todos, path)).toMatchObject({
		fields: { title: 'Mine', done: false },
		body: 'later\n',
	});

	// Another failure, then Reload: the file replaces the input, and nothing is written.
	const before = await text(todos, path);
	failNext();
	typeTitle(editor, 'Lost');
	expect(await written(editor)).toBeDefined();
	expect(await todos.reload(path)).toBeUndefined();
	expect(todoEditor(todos)).toBe(editor);
	expect(fieldsOf(editor).fields.title).toBe('Mine');
	expect(editor.save.status).toBe('idle');
	expect(todos.unsaved).toBe(false);
	expect(await text(todos, path)).toBe(before);
});

test('a reload whose read fails keeps the input on screen and says why', async () => {
	const todos = await open();
	await todos.create('Milk');
	const path = shownPath(todos)!;
	const editor = todoEditor(todos);
	typeNotes(editor, 'mine\n');
	expect(await written(editor)).toBeUndefined();
	const binary = new Uint8Array([0xff, 0xfe, 0]);
	expectOk(await todos.folder.files.overwrite(path, binary));

	expect(await todos.reload(path)).toContain('could not be read');
	expect(todoEditor(todos)).toBe(editor);
	expect(fieldsOf(editor).body).toBe('mine\n');
	expect(await bytes(todos, path)).toEqual(binary);
});

test('a todo whose editor did not open shows that failure, never a plain text editor even when the file reads, and opening it again opens its todo editor', async () => {
	const todos = await open();
	expectOk(await todos.folder.files.create('todos/milk.md', ROW));
	await todos.refresh();
	const table = todos.folder.tables.todos;
	const edit = table.edit;
	table.edit = async () => {
		table.edit = edit;
		return FileError.Io({
			path: 'todos/milk.md',
			operation: 'read',
			cause: 'busy',
		});
	};
	await todos.open('todos/milk.md', 'todos');
	expect(todos.current).toMatchObject({
		workspace: 'todos',
		item: { kind: 'failed', message: expect.stringContaining('busy') },
	});
	// The file reads fine now; the todo list still opens no plain editor.
	expect(await text(todos, 'todos/milk.md')).toBe(ROW);
	expect(todos.unsaved).toBe(false);

	await todos.open('todos/milk.md', 'todos');
	expect(fieldsOf(todoEditor(todos)).fields.title).toBe('Note');
});

test('a todo row that cannot be saved changes nothing and holds nothing up: leaving, rename, and close proceed', async () => {
	const todos = await open();
	await todos.create('Milk');
	const path = shownPath(todos)!;
	const saved = await text(todos, path);
	const editor = todoEditor(todos);

	expect(typeNotes(editor, 'mine \uD800')).toContain('not taken');
	expect(editor.refusal?.reason).toContain('lone surrogate');
	expect(fieldsOf(editor).body).toBe('');
	expect(todos.unsaved).toBe(false);
	expect(todos.saveProblems).toBe(0);
	expect(await text(todos, path)).toBe(saved);

	// Rename settles as usual; the editor at the new path starts with no notice.
	expect(await todos.rename(path, 'oat.md')).toBeUndefined();
	const moved = todoEditor(todos);
	expect(moved).not.toBe(editor);
	expect(moved.refusal).toBeUndefined();
	expect(await text(todos, 'todos/oat.md')).toBe(saved);

	expect(typeTitle(moved, '\uD800')).toContain('not taken');
	expect(await close(todos)).toEqual({ unsettled: [] });
});

test('a removed raw draft can be explicitly discarded after its save conflicts', async () => {
	const todos = await open();
	await todos.folder.files.create('notes.txt', 'saved');
	await todos.open('notes.txt', 'files');
	const editor = textEditor(todos);
	editor.input('mine');
	await removeNow(todos, 'notes.txt');
	await editor.save();
	expect(editor.buffer).toBe('mine');
	expect(todos.unsaved).toBe(true);
	todos.discard('notes.txt');
	expect(todos.current?.item).toBeUndefined();
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
		const path = shownPath(todos);
		release();
		await older;
		expect(shownPath(todos)).toBe(path);
		expect(todos.current?.item?.kind).toBe('todo');
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
	await todos.open('notes.txt', 'files');
	const editor = textEditor(todos);
	release();
	await older;
	expect(textEditor(todos)).toBe(editor);
	expect(shownPath(todos)).toBe('notes.txt');
});

test('a toggle on an open todo writes its complete row with the latest notes and unknown metadata', async () => {
	const todos = await open();
	const path = 'todos/milk.md';
	expectOk(
		await todos.folder.files.create(
			path,
			'---\ntitle: Milk\ndone: false\nowner: sam\n---\n',
		),
	);
	await todos.refresh();
	await todos.open(path, 'todos');
	const editor = todoEditor(todos);
	typeNotes(editor, 'mine\n');

	expect(await todos.toggle(todos.entries[0]!)).toBeUndefined();
	expect(fieldsOf(editor).fields.title).toBe('Milk');
	expect(fieldsOf(editor).fields.done).toBe(true);
	expect(fieldsOf(editor).body).toBe('mine\n');
	expect(editor.isIdle).toBe(true);
	expect(await text(todos, path)).toBe(accepted(editor));
	expect(await reading(todos, path)).toMatchObject({
		fields: { title: 'Milk', done: true },
		body: 'mine\n',
	});
	expect(await text(todos, path)).toContain('"owner": "sam"');
});

test("a toggle while Files holds a todo assigns done in its plain editor's current text, unsaved typing included, and that same editor saves it, keeping every other byte and the view", async () => {
	const { during, adapt } = interceptingFileOperations();
	const todos = await open(adapt);
	const path = 'todos/milk.md';
	const source =
		"---\r\n# kept by sam\r\ntitle: 'Milk'\r\ndone: false # flip me\r\nowner: sam\r\n---\r\nNotes\r\n";
	expectOk(await todos.folder.files.create(path, source));
	await todos.refresh();
	const listed = todos.entries[0]!;
	await todos.open(path, 'files');
	const file = textEditor(todos);
	// No second publisher: the table writes nothing for this toggle.
	const table = todos.folder.tables.todos;
	table.update = async () => {
		throw new Error('A second publisher wrote the row');
	};

	const typed = `${source}more notes\r\n`;
	file.input(typed);
	during.writes.length = 0;
	expect(await todos.toggle(listed)).toBeUndefined();
	const expected = typed.replace('done: false', 'done: true');
	expect(file.buffer).toBe(expected);
	expect(file.isIdle).toBe(true);
	expect(await text(todos, path)).toBe(expected);
	expect(during.writes).toEqual([path]);
	// Files still shows the same plain editor.
	expect(todos.current).toMatchObject({ workspace: 'files', path });
	expect(textEditor(todos)).toBe(file);
});

test('a toggle while Files holds text that does not read as a todo, or input it could not save, leaves that text as it is and sends nothing', async () => {
	const todos = await open(withoutHints);
	const path = 'todos/milk.md';
	expectOk(await todos.folder.files.create(path, ROW));
	await todos.refresh();
	const listed = todos.entries[0]!;
	await todos.open(path, 'files');
	const file = textEditor(todos);
	const table = todos.folder.tables.todos;
	table.update = async () => {
		throw new Error('A second publisher wrote the row');
	};

	const malformed = '---\ntitle: [unclosed\ndone: false\n---\n';
	file.input(malformed);
	expect(await todos.toggle(listed)).toContain('no longer reads as a todo');
	expect(file.buffer).toBe(malformed);

	// A save that failed holds its input; the toggle neither changes nor sends it.
	const binary = new Uint8Array([0x89, 0, 1]);
	expectOk(await todos.folder.files.overwrite(path, binary));
	file.input(`${ROW}mine\n`);
	await file.save();
	expect(file.saveState.kind).toBe('failed');
	expect(await todos.toggle(listed)).toBe(UNSETTLED);
	expect(file.buffer).toBe(`${ROW}mine\n`);
	expect(file.saveState.kind).toBe('failed');
	expect(await bytes(todos, path)).toEqual(binary);
});

test('a toggle with no editor open changes the row as it is now, not as it was listed, and keeps every other byte', async () => {
	const todos = await open(withoutHints);
	expectOk(await todos.folder.files.create('todos/milk.md', ROW));
	await todos.refresh();
	const listed = todos.entries[0]!;
	const theirs =
		"---\n# kept by sam\ntitle: 'Oat milk'\ndone: false # flip me\nowner: sam\n---\nNotes\n";
	expectOk(await todos.folder.files.overwrite('todos/milk.md', theirs));

	expect(await todos.toggle(listed)).toBeUndefined();
	// Only `done` changed: the other writer's title, comments, quoting,
	// unknown metadata, and notes are the bytes they wrote.
	expect(await text(todos, 'todos/milk.md')).toBe(
		theirs.replace('done: false', 'done: true'),
	);
	// The toggle opened no editor of its own, and nothing stays open.
	expect(todos.current?.item).toBeUndefined();
	expect(todos.unsaved).toBe(false);
	expect(todos.entries[0]!.fields.done).toBe(true);
});

test('a row with a field issue is named for repair instead of listed, and listed text with no canonical form toggles in place', async () => {
	const todos = await open(withoutHints);
	const titled = '---\ntitle: 12\ndone: false\n---\nNotes\n';
	const big = '---\ntitle: Big\ndone: false\nsize: 9007199254740993\n---\n';
	expectOk(await todos.folder.files.create('todos/titled.md', titled));
	expectOk(await todos.folder.files.create('todos/big.md', big));
	await todos.refresh();
	const entry = (path: string) =>
		todos.entries.find((listed) => listed.path === path)!;

	expect(todos.entries.map((listed) => listed.path)).toEqual(['todos/big.md']);
	expect(todos.repairs).toEqual([
		{ path: 'todos/titled.md', reason: expect.stringMatching(/\S/) },
	]);
	expect(await todos.toggle(entry('todos/big.md'))).toBeUndefined();
	expect(await text(todos, 'todos/big.md')).toBe(
		big.replace('done: false', 'done: true'),
	);
	expect(todos.unsaved).toBe(false);
});

test('a toggle with no editor open refuses text that no longer parses, and a row that is gone, writing nothing', async () => {
	const todos = await open(withoutHints);
	expectOk(await todos.folder.files.create('todos/milk.md', ROW));
	await todos.refresh();
	const listed = todos.entries[0]!;
	const broken = '---\ntitle: [unclosed\ndone: false\n---\n';
	expectOk(await todos.folder.files.overwrite('todos/milk.md', broken));

	expect(await todos.toggle(listed)).toContain('no longer reads as a todo');
	expect(await text(todos, 'todos/milk.md')).toBe(broken);

	await removeNow(todos, 'todos/milk.md');
	expect(await todos.toggle(listed)).toBe(
		'This todo is no longer in the folder.',
	);
	// The toggle never writes the row back.
	expect(await text(todos, 'todos/milk.md')).toBeUndefined();
});

/**
 * OPFS handles that call `afterRead` with a file's own handle once a read of
 * its bytes has finished, before the reader gets them: the window between a
 * structured update's read and its publication.
 */
function watchReads(
	directory: OpfsDirectoryHandle,
	afterRead: (file: OpfsFileHandle) => Promise<void>,
): OpfsDirectoryHandle {
	const watchFile = (file: OpfsFileHandle): OpfsFileHandle => ({
		kind: 'file',
		name: file.name,
		createWritable: (options) => file.createWritable(options),
		async getFile() {
			const read = await file.getFile();
			return {
				size: read.size,
				async arrayBuffer() {
					const buffer = await read.arrayBuffer();
					await afterRead(file);
					return buffer;
				},
			};
		},
	});
	return {
		kind: 'directory',
		name: directory.name,
		getDirectoryHandle: async (name, options) =>
			watchReads(await directory.getDirectoryHandle(name, options), afterRead),
		getFileHandle: async (name, options) =>
			watchFile(await directory.getFileHandle(name, options)),
		removeEntry: (name, options) => directory.removeEntry(name, options),
		async *values() {
			for await (const entry of directory.values())
				yield entry.kind === 'file'
					? watchFile(entry)
					: watchReads(entry, afterRead);
		},
	};
}

test('a toggle with no editor open is refused when another writer lands between its read and its save, and keeps their bytes', async () => {
	let race: ((file: OpfsFileHandle) => Promise<void>) | undefined;
	const storage = createTestStorage();
	const folder = expectOk(
		await openFolder({
			id: `todos-test-${count++}`,
			definition: todosDefinition,
			browser: {
				author: { name: 'Test', email: 'test@example.test' },
				commitOnEdit: false,
				opfs: {
					locks: testLocks,
					getDirectory: async () =>
						watchReads(await storage.opfs.getDirectory(), async (file) => {
							if (file.name !== 'milk.md') return;
							const act = race;
							race = undefined;
							await act?.(file);
						}),
				},
			},
		}),
	);
	const todos = createTodos(withoutHints(folder));
	opened.push(todos);
	expectOk(await todos.folder.files.create('todos/milk.md', ROW));
	await todos.refresh();
	const theirs = '---\ntitle: Theirs\ndone: false\n---\n';
	let raced = 0;
	race = async (file) => {
		raced++;
		const writable = await file.createWritable();
		await writable.write(new TextEncoder().encode(theirs));
		await writable.close();
	};

	expect(await todos.toggle(todos.entries[0]!)).toBe(
		'The file has different content now. Nothing was changed. Check it and try again.',
	);
	expect(raced).toBe(1);
	// One attempt, no retry: the other writer's bytes stay, and the list shows them.
	expect(await text(todos, 'todos/milk.md')).toBe(theirs);
	expect(todos.entries[0]!.fields).toEqual({ title: 'Theirs', done: false });
});

test('a toggle with no editor open whose reply was lost says so, even when a reread finds its bytes', async () => {
	const storage = createTestStorage();
	const folder = expectOk(
		await openFolder({
			id: `todos-test-${count++}`,
			definition: todosDefinition,
			browser: {
				author: { name: 'Test', email: 'test@example.test' },
				commitOnEdit: false,
				...browserStorage(storage),
			},
		}),
	);
	const todos = createTodos(withoutHints(folder));
	opened.push(todos);
	expectOk(await todos.folder.files.create('todos/milk.md', ROW));
	await todos.refresh();
	const { faults } = opfsOf(storage);
	faults.close = (path) => {
		if (!path.endsWith('todos/milk.md')) return undefined;
		faults.close = undefined;
		return 'lost';
	};

	// Uncertainty, not failure, with the folder's own account of the cause.
	const problem = await todos.toggle(todos.entries[0]!);
	expect(problem).toContain('may or may not');
	expect(problem).toContain('Injected lost close reply');
	// The reread finds the toggled bytes; that is not an answer to the toggle.
	expect(await text(todos, 'todos/milk.md')).toBe(
		ROW.replace('done: false', 'done: true'),
	);
	expect(todos.entries[0]!.fields.done).toBe(true);
	expect(todos.unsaved).toBe(false);
});

test('an open todo whose row another writer made invalid stays open with its editor after the list leaves it out and names it for repair; reloaded, it shows that text, and a toggle writes nothing', async () => {
	const todos = await open(withoutHints);
	await todos.create('Milk');
	const path = shownPath(todos)!;
	const editor = todoEditor(todos);
	const listed = todos.entries[0]!;
	// Another writer's title no longer conforms; `done` still reads.
	const theirs = '---\ntitle: 12\ndone: false\n---\n';
	expectOk(await todos.folder.files.overwrite(path, theirs));
	await todos.check();
	expect(todos.entries).toEqual([]);
	expect(todos.repairs).toEqual([
		{ path, reason: expect.stringMatching(/\S/) },
	]);
	// The list left it out; the detail and its editor stay.
	expect(todoEditor(todos)).toBe(editor);
	expect(editor.row.status).toBe('valid');

	expect(await todos.reload(path)).toBeUndefined();
	expect(todoEditor(todos)).toBe(editor);
	expect(editor.row).toMatchObject({ status: 'invalid', text: theirs });
	expect(editor.diagnostics()?.details.length).toBeGreaterThan(0);

	// The open todo has no fields to change; Files is where to repair it.
	expect(await todos.toggle(listed)).toContain('Open it in Files');
	expect(await text(todos, path)).toBe(theirs);
});

/**
 * Todos over a folder whose next save of a todo row, once armed, publishes
 * its bytes and loses the reply, as a stream close that throws after
 * publishing. One open todo, Milk, is selected.
 */
async function openLosingNextSave() {
	const storage = createTestStorage();
	const folder = expectOk(
		await openFolder({
			id: `todos-test-${count++}`,
			definition: todosDefinition,
			browser: {
				author: { name: 'Test', email: 'test@example.test' },
				commitOnEdit: false,
				...browserStorage(storage),
			},
		}),
	);
	const todos = createTodos(folder);
	opened.push(todos);
	await todos.check();
	await todos.create('Milk');
	const { faults } = opfsOf(storage);
	const loseNext = () => {
		faults.close = (path) => {
			if (!/\/todos\/[^/]+\.md$/.test(path)) return undefined;
			faults.close = undefined;
			return 'lost';
		};
	};
	return { todos, loseNext };
}

test("a list toggle while an open todo's save runs proceeds after its lost reply", async () => {
	const { todos, loseNext } = await openLosingNextSave();
	const path = shownPath(todos)!;
	const editor = todoEditor(todos);
	loseNext();
	typeNotes(editor, 'mine\n');
	expect(editor.isSaving).toBe(true);
	expect(await todos.toggle(todos.entries[0]!)).toBeUndefined();
	expect(fieldsOf(editor).fields.done).toBe(true);
	expect(fieldsOf(editor).body).toBe('mine\n');
	expect(editor.save.status).toBe('idle');
	expect(await reading(todos, path)).toMatchObject({
		fields: { title: 'Milk', done: true },
		body: 'mine\n',
	});
});

test('a list toggle while an open todo saves is queued, not refused, and publishes the complete row after that save', async () => {
	const { todos } = await openLosingNextSave();
	const path = shownPath(todos)!;
	const editor = todoEditor(todos);
	typeNotes(editor, 'mine\n');
	expect(editor.isSaving).toBe(true);

	expect(await todos.toggle(todos.entries[0]!)).toBeUndefined();
	expect(editor.isIdle).toBe(true);
	expect(await reading(todos, path)).toMatchObject({
		fields: { title: 'Milk', done: true }, body: 'mine\n',
	});
});

for (const [stem, repaired] of [
	['bad ', 'good'],
	['', 'named'],
] as const)
	test(`a row at the literal stem ${JSON.stringify(stem)} is an ordinary todo: it toggles, saves over another writer, and renames to any literal name`, async () => {
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

		await todos.open(path, 'todos');
		const editor = todoEditor(todos);
		expect(editor.path).toBe(path);
		expectOk(await todos.folder.files.overwrite(path, `${ROW}theirs\n`));
		// The next edit writes the complete row at the same stem, over the other writer.
		typeNotes(editor, 'mine\n');
		expect(await written(editor)).toBeUndefined();
		const mine = accepted(editor);
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
		expect(todoEditor(todos).path).toBe('todos/a: b? .md');
		expect(await todos.rename('todos/a: b? .md', `${repaired}.md`)).toBe(
			undefined,
		);
		expect(await text(todos, 'todos/a: b? .md')).toBeUndefined();
		const renamedPath = `todos/${repaired}.md`;
		expect(await text(todos, renamedPath)).toBe(mine);
		const renamed = todoEditor(todos);
		expect(renamed.path).toBe(renamedPath);
		expect(renamed.row.status).toBe('valid');

		// After the rename, typing saves where the row is now, over another writer.
		expectOk(
			await todos.folder.files.overwrite(
				renamedPath,
				`${mine}theirs after the rename\n`,
			),
		);
		typeNotes(renamed, 'mine after the rename\n');
		expect(await written(renamed)).toBeUndefined();
		expect(todoEditor(todos)).toBe(renamed);
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
	await todos.open('notes.txt', 'files');
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
	await todos.open('notes.txt', 'files');
	const editor = textEditor(todos);

	expect(await todos.rename('notes.txt', 'hello.txt')).toBeUndefined();
	expect(shownPath(todos)).toBe('hello.txt');
	expect(textEditor(todos)).toBe(editor);
	expect(editor.path).toBe('hello.txt');
	expect(await text(todos, 'notes.txt')).toBeUndefined();

	editor.input('hello again');
	await editor.save();
	expect(await text(todos, 'hello.txt')).toBe('hello again');
});

test('a file renamed into a todo row stays a plain editor in Files at its new name, and opens as a todo only when asked', async () => {
	const todos = await open();
	await todos.folder.files.create('todos/note.txt', ROW);
	await todos.refresh();
	await todos.open('todos/note.txt', 'files');
	const editor = textEditor(todos);
	editor.input(`${ROW}mine\n`);

	expect(await todos.rename('todos/note.txt', 'note.md')).toBeUndefined();
	expect(shownPath(todos)).toBe('todos/note.md');
	expect(textEditor(todos)).toBe(editor);
	expect(editor.path).toBe('todos/note.md');
	expect(todos.unsaved).toBe(false);
	expect(todos.entries.map((entry) => entry.path)).toEqual(['todos/note.md']);

	// Opened from the list, the plain editor is let go and the todo opens.
	await todos.open('todos/note.md', 'todos');
	expect(todoEditor(todos).row).toMatchObject({
		status: 'valid',
		fields: { title: 'Note', done: false },
		body: 'mine\n',
	});
	// The raw save wrote the text as typed; opening the todo rewrote nothing.
	expect(await text(todos, 'todos/note.md')).toBe(`${ROW}mine\n`);
	expect(await text(todos, 'todos/note.txt')).toBeUndefined();
	editor.input('late');
	expect(editor.buffer).toBe(`${ROW}mine\n`);
});

test('typing during a rename into a todo row keeps the raw editor, and a later table rename saves it first and keeps it a plain editor', async () => {
	const { during, adapt } = interceptingFileOperations();
	const todos = await open(adapt);
	await todos.folder.files.create('todos/note.txt', ROW);
	await todos.refresh();
	await todos.open('todos/note.txt', 'files');
	const editor = textEditor(todos);

	during.act = () => editor.input(`${ROW}typed during\n`);
	expect(await todos.rename('todos/note.txt', 'note.md')).toBeUndefined();
	during.act = undefined;
	expect(shownPath(todos)).toBe('todos/note.md');
	expect(textEditor(todos)).toBe(editor);
	expect(editor.buffer).toBe(`${ROW}typed during\n`);
	expect(todos.unsaved).toBe(true);

	// The table now lists the row, so its rename goes through the table and
	// first saves what the raw editor holds. Files keeps the plain editor.
	// The same-stem image is not the row's and stays.
	expect(todos.isTodo('todos/note.md')).toBe(true);
	await todos.folder.files.create('todos/note.png', new Uint8Array([7]));
	during.writes.length = 0;
	expect(await todos.rename('todos/note.md', 'kept.md')).toBeUndefined();
	expect(during.writes).toEqual(['todos/note.md']);
	expect(await text(todos, 'todos/kept.md')).toBe(`${ROW}typed during\n`);
	expect(await bytes(todos, 'todos/note.png')).toEqual(new Uint8Array([7]));
	expect(await bytes(todos, 'todos/kept.png')).toBeUndefined();
	expect(shownPath(todos)).toBe('todos/kept.md');
	expect(textEditor(todos)).toBe(editor);
	expect(editor.path).toBe('todos/kept.md');
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
	await todos.open('todos/draft.txt', 'files');
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
	expect(shownPath(todos)).toBe('todos/renamed.txt');
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
	await todos.open('notes.txt', 'files');
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
	await todos.open('notes.txt', 'files');
	const editor = textEditor(todos);

	during.writes.length = 0;
	const held = arm();
	const renaming = todos.rename('notes.txt', 'renamed.txt');
	const release = await held();
	await todos.refresh();
	const listed = todos.listing?.files.map((file) => file.path);
	expect(listed).toContain('renamed.txt');
	expect(listed).not.toContain('notes.txt');
	expect(shownPath(todos)).toBe('notes.txt');

	release();
	expect(await renaming).toBeUndefined();
	expect(shownPath(todos)).toBe('renamed.txt');
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
	await todos.open('a.txt', 'files');
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
	await todos.open('c.txt', 'files');
	expect(todos.current?.item).toBeUndefined();
	expect(await text(todos, 'b.txt')).toBe('b.txt');

	release();
	expect(await renaming).toBeUndefined();
	expect(shownPath(todos)).toBe('c.txt');
	expect(textEditor(todos)).toBe(editor);
	expect(editor.path).toBe('c.txt');
	expect(await todos.rename('c.txt', 'd.txt')).toBeUndefined();
	expect(editor.path).toBe('d.txt');
});

test('a todo rename fences its editor: input and a toggle are refused until a new editor is at the new path', async () => {
	const todos = await open();
	await todos.create('Milk');
	const path = shownPath(todos)!;
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
	expect(editor.isFenced).toBe(true);
	expect(typeNotes(editor, 'typed during\n')).toBe(BUSY);
	expect(fieldsOf(editor).body).toBe('');
	expect(editor.retry()).toBe(BUSY);
	expect(await todos.reload(path)).toBe(BUSY);
	expect(await text(todos, 'todos/oat.md')).toBe(original);
	expect(await text(todos, path)).toBeUndefined();

	release();
	expect(await renaming).toBeUndefined();
	expect(shownPath(todos)).toBe('todos/oat.md');
	const moved = todoEditor(todos);
	expect(moved).not.toBe(editor);
	expect(moved.path).toBe('todos/oat.md');
	expect(moved.isFenced).toBe(false);
	// The same-stem image did not move with the row.
	expect(await bytes(todos, image)).toEqual(new Uint8Array([7]));
	expect(await bytes(todos, 'todos/oat.png')).toBeUndefined();
	typeNotes(moved, 'typed after\n');
	expect(await written(moved)).toBeUndefined();
	expect((await reading(todos, 'todos/oat.md')).body).toBe('typed after\n');
	expect(await text(todos, path)).toBeUndefined();
	await todos.refresh();
	expect(await todos.toggle(todos.entries[0]!)).toBeUndefined();
	expect(fieldsOf(moved).fields.done).toBe(true);
	expect(await text(todos, path)).toBeUndefined();
});

test('a rename whose destination another program made invalid opens its todo editor there with why, repaired in Files at the new path it reopens as a todo, and nothing is written at the old path', async () => {
	const todos = await open();
	await todos.create('Milk');
	const path = shownPath(todos)!;
	const editor = todoEditor(todos);
	typeNotes(editor, 'typed before\n');
	const table = todos.folder.tables.todos;
	const rename = table.rename.bind(table);
	let release: (() => void) | undefined;
	// Another program rewrites the moved file as text that is not a valid todo
	// before the todo editor opens there.
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
	// The typing was written before the move.
	expect((await reading(todos, 'todos/oat.md')).body).toBe('typed before\n');
	const invalid = '---\ntitle: Oat\ndone: soon\n---\n';
	expectOk(await todos.folder.files.overwrite('todos/oat.md', invalid));
	release();
	expect(await renaming).toBeUndefined();

	expect(shownPath(todos)).toBe('todos/oat.md');
	const moved = todoEditor(todos);
	expect(moved.path).toBe('todos/oat.md');
	expect(moved.row).toMatchObject({ status: 'invalid', text: invalid });
	expect(moved.diagnostics()?.summary).toContain('need fixing');

	// The repair is the file's text, in Files, at the new path.
	await todos.open('todos/oat.md', 'files');
	const file = textEditor(todos);
	expect(file.buffer).toBe(invalid);
	file.input('---\ntitle: Oat\ndone: true\n---\ntyped before\n');
	await file.save();
	expect(await reading(todos, 'todos/oat.md')).toMatchObject({
		fields: { title: 'Oat', done: true },
		body: 'typed before\n',
	});
	await todos.open('todos/oat.md', 'todos');
	expect(fieldsOf(todoEditor(todos)).fields).toMatchObject({ done: true });
	expect(await text(todos, path)).toBeUndefined();
});

test('a rename never lands on an open editor, clean or holding a removed draft', async () => {
	const todos = await open();
	for (const path of ['a.txt', 'b.txt'])
		await todos.folder.files.create(path, path);
	await todos.refresh();
	await todos.open('b.txt', 'files');
	const destination = textEditor(todos);
	await todos.open('a.txt', 'files');
	const source = textEditor(todos);

	expect(await todos.rename('a.txt', 'b.txt')).toContain('open in an editor');
	destination.input('mine');
	await removeNow(todos, 'b.txt');
	expect(await todos.rename('a.txt', 'b.txt')).toContain('open in an editor');

	expect(await text(todos, 'a.txt')).toBe('a.txt');
	expect(source.path).toBe('a.txt');
	expect(destination.buffer).toBe('mine');
	await todos.open('b.txt', 'files');
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
	await todos.open('a.txt', 'files');
	const editor = textEditor(todos);

	let ungate = () => {};
	gate = new Promise<void>((resolve) => {
		ungate = resolve;
	});
	const opening = todos.open('c.txt', 'files');
	during.writes.length = 0;
	const held = arm();
	const renaming = todos.rename('a.txt', 'c.txt');
	const release = await held();
	gate = undefined;
	ungate();
	await opening;
	// The open read the moved bytes, but the path belongs to the rename.
	expect(todos.current?.item).toBeUndefined();
	expect(todos.saving || todos.unsaved).toBe(false);

	release();
	expect(await renaming).toBeUndefined();
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
	await todos.open('notes.txt', 'files');
	const editor = textEditor(todos);

	// The move's first step lands: the destination holds the captured bytes.
	// Its second step, removing the source, fails.
	during.refuse = async (from, to) => {
		const captured = expectOk(await todos.folder.files.read(from));
		const moved = expectOk(await todos.folder.files.create(to, captured.bytes));
		// A file move is guarded, so its kept source names the moved capture.
		return MoveError.SourceNotRemoved({
			from,
			to,
			moved,
			cause: sourceKept(from),
		}) as Err<CapturedMoveError>;
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
	expect(shownPath(todos)).toBe('notes.txt');
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

test('a todo rename that lands its new path but keeps its old one leaves both rows, and the editor stays at the old path', async () => {
	const todos = await open();
	await todos.create('Milk');
	const path = shownPath(todos)!;
	const editor = todoEditor(todos);
	const original = (await text(todos, path))!;
	const table = todos.folder.tables.todos;
	const rename = table.rename;
	table.rename = async (stem, nextStem, options) => {
		const from = `todos/${stem}.md`;
		const to = `todos/${nextStem}.md`;
		const captured = expectOk(await todos.folder.files.read(from));
		// The move is conditional on the row as read after the editor settled.
		expect(options?.expectedSha256).toBe(captured.sha256);
		const moved = expectOk(await todos.folder.files.create(to, captured.bytes));
		// Input during the move is refused, not carried.
		expect(typeNotes(editor, 'typed during\n')).toBe(BUSY);
		return MoveError.SourceNotRemoved({
			from,
			to,
			moved,
			cause: sourceKept(from),
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
	expect(shownPath(todos)).toBe(path);
	expect(todoEditor(todos)).toBe(editor);
	expect(editor.path).toBe(path);
	expect(fieldsOf(editor).body).toBe('');

	// Typing after the refusal saves at the old path, which still holds the row.
	typeNotes(editor, 'typed after\n');
	expect(await editor.settle()).toBe(true);
	expect((await reading(todos, path)).body).toBe('typed after\n');
	expect(await text(todos, 'todos/oat.md')).toBe(original);
});

test('a todo rename whose reply was lost says so, and a todo holding nothing unwritten closes when the listing finds its old path empty', async () => {
	const todos = await open();
	await todos.create('Milk');
	const path = shownPath(todos)!;
	const editor = todoEditor(todos);
	typeNotes(editor, 'typed before\n');
	const table = todos.folder.tables.todos;
	const rename = table.rename.bind(table);
	// The move lands, but its reply never arrives.
	table.rename = async (stem, nextStem, options) => {
		expectOk(await rename(stem, nextStem, options));
		return FileError.Unconfirmed({
			path: `todos/${stem}.md`,
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
	const moved = (await text(todos, 'todos/oat.md'))!;
	expect(problem).toContain('may or may not');
	expect(problem).toContain('the reply was lost');
	// The typing was written before the move; the row is now only at the new path.
	expect((await reading(todos, 'todos/oat.md')).body).toBe('typed before\n');
	expect(editor.path).toBe(path);
	expect(editor.isIdle).toBe(true);
	expect(todos.current?.item).toBeUndefined();
	expect(todos.unsaved).toBe(false);
	// Nothing is written at either name.
	expect(await text(todos, path)).toBeUndefined();
	expect(await text(todos, 'todos/oat.md')).toBe(moved);
});

test("Files opens a todo's complete text in a plain editor, which saves it exactly and settles before table rename and delete", async () => {
	const todos = await open();
	await todos.folder.files.create('todos/milk.md', ROW);
	await todos.refresh();
	await todos.open('todos/milk.md', 'files');
	const editor = textEditor(todos);
	expect(editor.path).toBe('todos/milk.md');
	await todos.folder.files.create('todos/milk.png', new Uint8Array([7]));

	// The whole file, frontmatter included, and no todo editor beside it.
	expect(editor.buffer).toBe(ROW);
	expect(todos.current).toMatchObject({ workspace: 'files' });
	editor.input(`${ROW}mine\n`);
	await editor.save();
	expect(await text(todos, 'todos/milk.md')).toBe(`${ROW}mine\n`);

	// Typing moves with the row, saved first and kept exactly.
	editor.input(`${ROW}mine again\n`);
	expect(await todos.rename('todos/milk.md', 'oat.md')).toBeUndefined();
	expect(await text(todos, 'todos/oat.md')).toBe(`${ROW}mine again\n`);
	expect(await text(todos, 'todos/milk.md')).toBeUndefined();
	// The table rename moved the row alone; the image kept its name.
	expect(await bytes(todos, 'todos/milk.png')).toEqual(new Uint8Array([7]));
	expect(await bytes(todos, 'todos/oat.png')).toBeUndefined();
	expect(shownPath(todos)).toBe('todos/oat.md');
	// The same plain editor, at the new path.
	expect(textEditor(todos)).toBe(editor);
	expect(editor.path).toBe('todos/oat.md');
	await todos.folder.files.create('todos/oat.webm', new Uint8Array([9]));

	editor.input(`${ROW}last\n`);
	const deletion = await todos.deletionFor('todos/oat.md');
	expect(deletion.data).toMatchObject({
		kind: 'todo',
		entry: { path: 'todos/oat.md', text: `${ROW}last\n` },
	});
	expect(await todos.remove(deletion.data!)).toBeUndefined();
	expect(await text(todos, 'todos/oat.md')).toBeUndefined();
	// The table delete removed the row alone.
	expect(await bytes(todos, 'todos/oat.webm')).toEqual(new Uint8Array([9]));
	expect(await bytes(todos, 'todos/milk.png')).toEqual(new Uint8Array([7]));
	expect(todos.current?.item).toBeUndefined();
	expect(todos.unsaved).toBe(false);
});

test('a todo editor settles before table rename and delete, and refuses both while a save failed', async () => {
	const { todos, path, failNext } = await openFailingNextWrite();
	const stem = await addSiblings(todos, path);
	const editor = todoEditor(todos);

	failNext();
	typeNotes(editor, 'first\n');
	expect(await todos.rename(path, 'oat.md')).toBe(UNSETTLED);
	expect((await todos.deletionFor(path)).error).toBe(UNSETTLED);
	expect(fieldsOf(editor).body).toBe('first\n');
	expect(editor.save.status).toBe('failed');
	expect((await reading(todos, path)).body).toBe('');

	// After Try again, the latest input lands before the rename moves the row.
	typeNotes(editor, 'notes\n');
	check(editor, true);
	expect(editor.retry()).toBeUndefined();
	expect(await todos.rename(path, 'oat.md')).toBeUndefined();
	expect(await reading(todos, 'todos/oat.md')).toMatchObject({
		fields: { done: true },
		body: 'notes\n',
	});
	const moved = todoEditor(todos);
	expect(moved.path).toBe('todos/oat.md');

	// Pending input saves before the deletion is captured.
	typeNotes(moved, 'last\n');
	const deletion = expectOk(await todos.deletionFor('todos/oat.md'));
	expect(deletion).toMatchObject({
		kind: 'todo',
		entry: { path: 'todos/oat.md', body: 'last\n' },
	});
	expect(await todos.remove(deletion)).toBeUndefined();
	expect(await text(todos, 'todos/oat.md')).toBeUndefined();
	await expectSiblings(todos, stem);
	expect(todos.current?.item).toBeUndefined();
	expect(todos.unsaved).toBe(false);
});

test('a row that does not read as a todo is named for repair instead of listed; Files opens its exact text, a saved repair lists it again without changing what Files shows, and it opens as a todo only when asked', async () => {
	const todos = await open();
	const broken = '---\ntitle: Bad\ndone: soon\n---\n';
	const aliased = '---\ntitle: *missing\ndone: false\n---\n';
	const unsupported =
		'---\ntitle: Big\ndone: false\nsize: 9007199254740993\n---\n';
	expectOk(await todos.folder.files.create('todos/bad.md', broken));
	expectOk(await todos.folder.files.create('todos/alias.md', aliased));
	expectOk(await todos.folder.files.create('todos/big.md', unsupported));
	await todos.check();

	// The list offers only rows that read as todos, and names the rest with why.
	expect(todos.entries.map((entry) => entry.path)).toEqual(['todos/big.md']);
	expect(todos.repairs).toEqual([
		{ path: 'todos/alias.md', reason: expect.stringMatching(/\S/) },
		{ path: 'todos/bad.md', reason: expect.stringMatching(/\S/) },
	]);
	expect(todos.isTodo('todos/bad.md')).toBe(true);

	// Text with no canonical form can still be listed; opened as a todo, its
	// editor says why rather than showing fields. So does an explicit open of
	// a row that does not parse.
	await todos.open('todos/big.md', 'todos');
	expect(todoEditor(todos).diagnostics()?.summary).toContain('safe range');
	await todos.open('todos/alias.md', 'todos');
	expect(todoEditor(todos).diagnostics()?.summary).toContain('no anchor');

	// Files opens the complete text, and repair saves exactly as typed.
	await todos.open('todos/bad.md', 'files');
	const file = textEditor(todos);
	expect(file.buffer).toBe(broken);
	const fixed = '---\ntitle: Fixed\ndone: false\n---\n';
	file.input(fixed);
	await file.save();
	expect(await text(todos, 'todos/bad.md')).toBe(fixed);
	await todos.check();
	expect(todos.entries.map((entry) => entry.path)).toEqual([
		'todos/bad.md',
		'todos/big.md',
	]);
	expect(todos.repairs.map((repair) => repair.path)).toEqual([
		'todos/alias.md',
	]);
	// Valid now, and still the text editor the person opened.
	expect(textEditor(todos)).toBe(file);

	// Opening it from the list lets the plain editor go and shows its fields.
	await todos.open('todos/bad.md', 'todos');
	const bad = todoEditor(todos);
	expect(fieldsOf(bad).fields).toEqual({ title: 'Fixed', done: false });
	expect(await text(todos, 'todos/bad.md')).toBe(fixed);
	expect(todos.unsaved).toBe(false);
});

test('typing during a delete stays as a draft of the removed file until it is discarded', async () => {
	const { during, adapt } = interceptingFileOperations();
	const todos = await open(adapt);
	await todos.folder.files.create('notes.txt', 'saved');
	await todos.refresh();
	await todos.open('notes.txt', 'files');
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
	expect(todos.current?.item).toBeUndefined();
	expect(todos.unsaved).toBe(false);
});

test('a draft whose saved file became unreadable is kept until it is explicitly discarded, then reopens as details', async () => {
	const todos = await open();
	await todos.folder.files.create('notes.txt', 'saved');
	await todos.refresh();
	await todos.open('notes.txt', 'files');
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
	expect(shownPath(todos)).toBe('notes.txt');
	expect(todos.saveProblems).toBe(1);

	todos.discard('notes.txt');
	expect(todos.current?.item).toBeUndefined();
	expect(todos.unsaved).toBe(false);
	expect(await bytes(todos, 'notes.txt')).toEqual(binary);
	await todos.open('notes.txt', 'files');
	expect(todos.current?.item).toMatchObject({ kind: 'binary', size: 3 });
});

test('a clean or merely dirty editor is not discarded', async () => {
	const todos = await open();
	await todos.folder.files.create('notes.txt', 'saved');
	await todos.refresh();
	await todos.open('notes.txt', 'files');
	const editor = textEditor(todos);

	todos.discard('notes.txt');
	editor.input('mine');
	todos.discard('notes.txt');
	expect(shownPath(todos)).toBe('notes.txt');
	expect(editor.buffer).toBe('mine');

	// A changed file is reviewed through its conflict choices, not discarded here.
	await todos.folder.files.overwrite('notes.txt', 'theirs');
	await editor.save();
	expect(editor.saveState.kind).toBe('conflict');
	todos.discard('notes.txt');
	expect(shownPath(todos)).toBe('notes.txt');
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
	const stale = todos.open('notes.txt', 'files');
	while (gates.length < 1) await Bun.sleep(1);
	hold = false;
	const deletion = await todos.deletionFor('notes.txt');
	expect(await todos.remove(deletion.data!)).toBeUndefined();
	expect(todos.current?.item).toBeUndefined();
	await todos.folder.files.create('notes.txt', 'new');
	hold = true;
	const current = todos.open('notes.txt', 'files');
	while (gates.length < 2) await Bun.sleep(1);
	hold = false;

	// The stale result opens no editor.
	gates[0]!();
	await stale;
	expect(todos.saving || todos.unsaved || todos.saveProblems > 0).toBe(false);
	gates[1]!();
	await current;
	const editor = textEditor(todos);
	expect(editor.baseline.text).toBe('new');
	editor.input('mine');
	await editor.save();
	expect(await text(todos, 'notes.txt')).toBe('mine');
});

test('the surface a path is opened from decides its editor: Files opens non-text as details and a todo as text, the list opens a todo editor', async () => {
	const todos = await open();
	await todos.folder.files.create('photo.png', new Uint8Array([0x89, 0, 1]));
	expect(await todos.create('Bread')).toBeUndefined();
	const row = shownPath(todos)!;
	const created = todoEditor(todos);
	await todos.refresh();

	await todos.open('photo.png', 'files');
	expect(todos.current?.item).toMatchObject({ kind: 'binary', size: 3 });
	await todos.open(row, 'files');
	expect(textEditor(todos).buffer).toBe((await text(todos, row))!);
	// One publisher per file: the todo editor was let go for Files.
	expect(created.isFenced).toBe(true);
	await todos.open(row, 'todos');
	expect(todoEditor(todos)).not.toBe(created);
	expect(fieldsOf(todoEditor(todos)).fields.title).toBe('Bread');
});

test('opening a todo in Files stops its input at once and waits for its writes; a failed write keeps the todo and its input with nothing opened in its place, and once saved Files opens the text and the old editor takes nothing', async () => {
	const { todos, path, failNext } = await openFailingNextWrite();
	const editor = todoEditor(todos);
	failNext();
	typeTitle(editor, 'Mine');
	const opening = todos.open(path, 'files');
	// The detail moved and the todo takes no more input, before its write settles.
	expect(todos.current).toMatchObject({ workspace: 'files', path });
	expect(typeNotes(editor, 'late\n')).toBe(BUSY);
	await opening;

	expect(editor.save.status).toBe('failed');
	expect(todos.current).toMatchObject({
		workspace: 'files',
		path,
		item: { kind: 'todo', editor },
	});
	expect(fieldsOf(editor).fields.title).toBe('Mine');
	expect(fieldsOf(editor).body).toBe('');
	expect(editor.isFenced).toBe(false);
	expect(todos.unsaved).toBe(true);
	expect((await reading(todos, path)).fields.title).toBe('Milk');

	// The person saves it again; opening it in Files then proceeds.
	expect(editor.retry()).toBeUndefined();
	expect(await written(editor)).toBeUndefined();
	await todos.open(path, 'files');
	const file = textEditor(todos);
	expect(file.buffer).toBe(accepted(editor));
	const saved = await text(todos, path);

	// The released todo, and anything still holding it, takes nothing.
	expect(typeTitle(editor, 'Old')).toContain('no longer open here');
	expect(editor.retry()).toContain('no longer open here');
	await todos.open(path, 'todos');
	const reopened = todoEditor(todos);
	expect(reopened).not.toBe(editor);
	expect(typeTitle(editor, 'Older')).toContain('no longer open here');
	expect(await text(todos, path)).toBe(saved);
	expect(fieldsOf(reopened).fields.title).toBe('Mine');
});

test('opening as a todo a file Files holds saves its typing first; a conflict keeps the plain editor and its input with nothing opened in its place, and once resolved the todo opens on the saved text', async () => {
	const todos = await open(withoutHints);
	expectOk(await todos.folder.files.create('todos/milk.md', ROW));
	await todos.refresh();
	await todos.open('todos/milk.md', 'files');
	const file = textEditor(todos);
	expectOk(
		await todos.folder.files.overwrite('todos/milk.md', `${ROW}theirs\n`),
	);
	file.input(`${ROW}mine\n`);

	await todos.open('todos/milk.md', 'todos');
	expect(file.saveState.kind).toBe('conflict');
	expect(todos.current).toMatchObject({
		workspace: 'todos',
		item: { kind: 'text', editor: file },
	});
	expect(file.buffer).toBe(`${ROW}mine\n`);
	expect(await text(todos, 'todos/milk.md')).toBe(`${ROW}theirs\n`);
	expect(todos.unsaved).toBe(true);

	// The person saves their own text over it; the todo then opens on that.
	await file.keepMine();
	await todos.open('todos/milk.md', 'todos');
	expect(fieldsOf(todoEditor(todos)).body).toBe('mine\n');
	// The let-go plain editor takes nothing more.
	file.input('late');
	await file.retry();
	expect(file.buffer).toBe(`${ROW}mine\n`);
	expect(await text(todos, 'todos/milk.md')).toBe(`${ROW}mine\n`);
	expect(todos.unsaved).toBe(false);
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
	const storage = createTestStorage({ BroadcastChannel });
	const handle = async () =>
		expectOk(
			await openFolder({
				id,
				definition: todosDefinition,
				browser: {
					author: { name: 'Test', email: 'test@example.test' },
					commitOnEdit: false,
					...browserStorage(storage),
				},
			}),
		);
	const todos = createTodos(await handle());
	opened.push(todos);
	await todos.check();
	return { todos, other: await handle(), faults: opfsOf(storage).faults };
}

test('a hint from another tab rereads the folder: new rows are listed and a clean editor adopts the saved text', async () => {
	const { todos, other } = await openWithAnotherTab();
	try {
		expectOk(await todos.folder.files.create('notes.txt', 'saved'));
		await todos.open('notes.txt', 'files');
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

test("another tab's change is listed while an open todo's failed save keeps its input and its error", async () => {
	const { todos, other, faults } = await openWithAnotherTab();
	try {
		await todos.create('Milk');
		const path = shownPath(todos)!;
		const saved = await text(todos, path);
		const editor = todoEditor(todos);
		faults.write = (file) => (file.endsWith(`/${path}`) ? 'fail' : undefined);
		typeTitle(editor, 'Mine');
		const problem = await written(editor);
		expect(problem).toBeDefined();
		faults.write = undefined;

		expectOk(
			await other.tables.todos.create({
				stem: 'bread',
				fields: { title: 'Bread', done: false },
			}),
		);
		// Nothing here asks the app to refresh.
		await eventually(() => todos.isTodo('todos/bread.md'));
		expect(todos.entries.map((entry) => entry.path)).toContain(
			'todos/bread.md',
		);
		expect(shownPath(todos)).toBe(path);
		expect(todoEditor(todos)).toBe(editor);
		expect(fieldsOf(editor).fields.title).toBe('Mine');
		expect(editor.save.status).toBe('failed');
		expect(await written(editor)).toBe(problem);
		expect(await text(todos, path)).toBe(saved);
	} finally {
		await other.close();
	}
});

/** An open todo, and another tab with a handle on the same folder. */
async function todoWithAnotherTab() {
	const { todos, other } = await openWithAnotherTab();
	await todos.create('Milk');
	const path = shownPath(todos)!;
	const editor = todoEditor(todos);
	return { todos, other, path, editor };
}

/** Another tab replaces the open todo's row, and the hint relists it. */
async function changeInAnotherTab(
	todos: Todos,
	other: Awaited<ReturnType<typeof openWithAnotherTab>>['other'],
): Promise<string | undefined> {
	expectOk(
		await other.tables.todos.update(
			todos.entries[0]!.stem,
			{ fields: { title: 'Oat milk', done: true }, body: 'theirs\n' },
			{},
		),
	);
	await eventually(() => todos.entries[0]?.fields.title === 'Oat milk');
	return text(todos, todos.entries[0]!.path);
}

test("another tab's change is listed but not read into an open todo, whose next edit writes its complete row over theirs", async () => {
	const { todos, other, path, editor } = await todoWithAnotherTab();
	try {
		const theirs = await changeInAnotherTab(todos, other);
		expect(todos.entries[0]!.fields).toEqual({ title: 'Oat milk', done: true });
		// The todo shows what it loaded and holds nothing unwritten.
		expect(fieldsOf(editor).fields.title).toBe('Milk');
		expect(fieldsOf(editor).fields.done).toBe(false);
		expect(editor.isIdle).toBe(true);
		expect(await text(todos, path)).toBe(theirs);

		typeNotes(editor, 'mine\n');
		expect(await written(editor)).toBeUndefined();
		expect(await reading(todos, path)).toMatchObject({
			fields: { title: 'Milk', done: false },
			body: 'mine\n',
		});
	} finally {
		await other.close();
	}
});

test("Reload loads another tab's change into the todo's controls and writes nothing", async () => {
	const { todos, other, path, editor } = await todoWithAnotherTab();
	try {
		const theirs = await changeInAnotherTab(todos, other);

		expect(await todos.reload(path)).toBeUndefined();
		// The values the title, done, and notes controls are bound to.
		expect(fieldsOf(editor).fields.title).toBe('Oat milk');
		expect(fieldsOf(editor).fields.done).toBe(true);
		expect(fieldsOf(editor).body).toBe('theirs\n');
		expect(editor.isIdle).toBe(true);
		expect(await text(todos, path)).toBe(theirs);
	} finally {
		await other.close();
	}
});

test('an open todo whose row another tab removed closes with the listing when it holds nothing unwritten, and writes nothing back', async () => {
	const { todos, other, path, editor } = await todoWithAnotherTab();
	try {
		expectOk(await other.files.remove(expectOk(await other.files.read(path))));
		await eventually(() => shownPath(todos) === undefined);
		expect(todos.current?.item).toBeUndefined();
		expect(todos.unsaved).toBe(false);

		// The released editor takes nothing more.
		expect(typeNotes(editor, 'late\n')).toContain('no longer open here');
		expect(fieldsOf(editor).body).toBe('');
		expect(await text(todos, path)).toBeUndefined();
	} finally {
		await other.close();
	}
});

test('Reload of a row another tab made malformed keeps the same todo editor, which shows that text and why', async () => {
	const { todos, other, path, editor } = await todoWithAnotherTab();
	try {
		const malformed = '---\ntitle: *missing\ndone: false\n---\ntheirs\n';
		expectOk(await other.files.overwrite(path, malformed));

		expect(await todos.reload(path)).toBeUndefined();
		expect(shownPath(todos)).toBe(path);
		expect(todoEditor(todos)).toBe(editor);
		expect(editor.row.status).toBe('invalid');
		expect(editor.row.text).toBe(malformed);
		expect(editor.diagnostics()?.summary).toContain('no anchor');
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
 * app's handle hears nothing of it.
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
	await todos.check();
	return { todos, other: await handle() };
}

const lostReply = (path: string) =>
	FileError.Unconfirmed({
		path,
		operation: 'remove',
		cause: new Error('the reply was lost'),
	});

test('an own delete whose reply was lost after it landed refuses typing during it and says so, and the idle todo closes with the listing; nothing writes the row again', async () => {
	const { todos, other } = await openWithSilentHandle();
	try {
		await todos.create('Milk');
		const path = shownPath(todos)!;
		const editor = todoEditor(todos);
		const deletion = expectOk(await todos.deletionFor(path));
		const table = todos.folder.tables.todos;
		const remove = table.delete;
		// The delete lands where this app hears nothing of it, and typing
		// arrives before its reply, which is lost.
		let typed: string | undefined;
		table.delete = async (stem, options) => {
			expectOk(await other.tables.todos.delete(stem, options));
			typed = typeNotes(editor, 'typed during\n');
			return lostReply(path);
		};
		let problem: string | undefined;
		try {
			problem = await todos.remove(deletion);
		} finally {
			table.delete = remove;
		}
		expect(problem).toContain('may or may not');
		expect(problem).toContain('the reply was lost');
		// The fence refused the typing during the delete.
		expect(typed).toBe(BUSY);
		expect(fieldsOf(editor).body).toBe('');
		expect(editor.isIdle).toBe(true);
		// The listing after the delete found the row gone and closed the todo.
		expect(todos.current?.item).toBeUndefined();
		expect(todos.unsaved).toBe(false);

		await close(todos);
		expect(expectErr(await other.files.read(path)).name).toBe('NotFound');
	} finally {
		await other.close();
	}
});

test('an own delete whose reply was lost before it landed keeps the todo open, and its typing writes as usual', async () => {
	const todos = await open();
	await todos.create('Milk');
	const path = shownPath(todos)!;
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

	// The row is still there, so the todo stays open and its typing writes.
	expect(shownPath(todos)).toBe(path);
	expect(todoEditor(todos)).toBe(editor);
	expect(await text(todos, path)).toBe(saved);
	typeNotes(editor, 'new typing\n');
	expect(await written(editor)).toBeUndefined();
	expect((await reading(todos, path)).body).toBe('new typing\n');
});

test('typing during an own delete that removed the row is refused, and the deleted todo closes', async () => {
	const { todos, other } = await openWithSilentHandle();
	try {
		await todos.create('Milk');
		const path = shownPath(todos)!;
		const editor = todoEditor(todos);
		const deletion = expectOk(await todos.deletionFor(path));
		const table = todos.folder.tables.todos;
		const remove = table.delete;
		let typed: string | undefined;
		table.delete = async (stem, options) => {
			const removed = await other.tables.todos.delete(stem, options);
			typed = typeNotes(editor, 'typed during\n');
			return removed;
		};
		try {
			expect(await todos.remove(deletion)).toBeUndefined();
		} finally {
			table.delete = remove;
		}
		expect(typed).toBe(BUSY);
		expect(fieldsOf(editor).body).toBe('');
		expect(todos.current?.item).toBeUndefined();
		expect(todos.unsaved).toBe(false);

		await todos.refresh();
		expect(await text(todos, path)).toBeUndefined();
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
	await todos.open('notes.txt', 'files');
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
	let hold: PromiseWithResolvers<void> | undefined;
	const started = Promise.withResolvers<void>();
	const storage = createTestStorage();
	const folder = expectOk(
		await openFolder({
			id: `todos-test-${count++}`,
			definition: todosDefinition,
			browser: {
				author: { name: 'Test', email: 'test@example.test' },
				commitOnEdit: false,
				opfs: {
					locks: testLocks,
					// The native editor's real save runs; only its publication is
					// held, once, until the test answers it.
					getDirectory: async () =>
						holdCloses(await storage.opfs.getDirectory(), async (file) => {
							const held = hold;
							if (held === undefined || !file.name.endsWith('.md')) return;
							hold = undefined;
							started.resolve();
							await held.promise;
						}),
				},
			},
		}),
	);
	const todos = createTodos(folder);
	opened.push(todos);
	await todos.check();
	await todos.create('Milk');
	const path = shownPath(todos)!;
	const editor = todoEditor(todos);
	const deletion = expectOk(await todos.deletionFor(path));

	const reply = Promise.withResolvers<void>();
	hold = reply;
	typeNotes(editor, 'mine\n');
	await started.promise;
	let answered = false;
	const removing = todos.remove(deletion).then((problem) => {
		answered = true;
		return problem;
	});
	await Bun.sleep(20);
	expect(answered).toBe(false);
	expect(editor.isFenced).toBe(true);

	reply.resolve();
	// The save landed first, so the confirmed version is no longer there.
	expect(await removing).toContain('different content now');
	expect((await reading(todos, path)).body).toBe('mine\n');
	expect(todoEditor(todos)).toBe(editor);
	expect(editor.isIdle).toBe(true);
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
	const opening = todos.open('notes.txt', 'files');
	const release = await held();
	await close(todos);
	release();
	await opening;
	expect(todos.current?.item).toBeUndefined();
});

test('a row open whose editor answers after close retains it nowhere and saves nothing through it', async () => {
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

	const opening = todos.open('todos/late.md', 'todos');
	await entered.promise;
	await close(todos);
	release.resolve();
	await opening;
	expect(todos.current?.item).toBeUndefined();
	expect(todos.entries).toEqual([]);
	// Nothing holds it, and it wrote nothing.
	expect(expectOk(late!).get()).toMatchObject({
		row: { status: 'valid', text: ROW },
		save: { status: 'idle' },
	});
	expect(todos.unsaved).toBe(false);
});

test('a listing that answers after close changes neither the rows nor a clean editor', async () => {
	const { adapt, arm } = recordingFolder();
	const todos = await open(adapt);
	expectOk(await todos.folder.files.create('notes.txt', 'saved'));
	await todos.open('notes.txt', 'files');
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
	expect(todos.current?.item).toBeUndefined();
	expect(shownPath(todos)).toBeUndefined();
});

test('close waits for a held rename, which moves the file and its plain editor and opens nothing new at the destination', async () => {
	const { adapt, arm } = interceptingFileOperations();
	const todos = await open(adapt);
	expectOk(await todos.folder.files.create('todos/note.txt', ROW));
	await todos.refresh();
	await todos.open('todos/note.txt', 'files');

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
	// The plain editor moved with the file; no todo editor opens there.
	expect(todos.current).toMatchObject({
		workspace: 'files',
		path: 'todos/note.md',
		item: { kind: 'text' },
	});
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
	await todos.open('notes.txt', 'files');
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
	let reentrant: ReturnType<Todos['close']> | undefined;
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
	await todos.open('notes.txt', 'files');
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
	expect(await first).toEqual({ unsettled: [] });
});

test('close names the paths whose input it could not settle, and neither saves nor replaces that input', async () => {
	const storage = createTestStorage();
	const folder = expectOk(
		await openFolder({
			id: `todos-test-${count++}`,
			definition: todosDefinition,
			browser: {
				author: { name: 'Test', email: 'test@example.test' },
				commitOnEdit: false,
				...browserStorage(storage),
			},
		}),
	);
	const todos = createTodos(folder);
	await todos.check();
	await todos.create('Failed');
	const failedPath = shownPath(todos)!;
	const failed = todoEditor(todos);
	await todos.create('Clean');
	const opfs = opfsOf(storage);
	/** The file's text in storage, readable after the folder closed. */
	const stored = (path: string) => {
		const found = [...opfs.files()].find(([key]) => key.endsWith(`/${path}`));
		return found && new TextDecoder().decode(found[1]);
	};

	// Two saves fail; close reports the latest unsaved input.
	opfs.faults.write = (path) => {
		if (!path.endsWith(`/${failedPath}`)) return undefined;
		return 'fail';
	};
	typeNotes(failed, 'first\n');
	expect(await written(failed)).toBeDefined();
	typeNotes(failed, 'held\n');
	expect(await written(failed)).toBeDefined();
	const failedText = stored(failedPath);

	const outcome = await todos.close();
	expect(outcome.unsettled).toEqual([failedPath]);
	// The failed input was not sent again; it is still what the person typed.
	expect(stored(failedPath)).toBe(failedText);
	expect(fieldsOf(failed).body).toBe('held\n');
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

	await todos.open('notes.txt', 'files');
	await todos.refresh();
	await todos.check();
	expect(await todos.reload(entry.path)).toBe(CLOSING);
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
	expect(expectErr(await todos.pull()).name).toBe('Closed');
	expect(expectErr(await todos.merge()).name).toBe('Closed');
	todos.terminal.command = 'touch shell.txt';
	await todos.terminal.run();
	expect(todos.terminal.runs.at(-1)?.result?.exitCode).toBe(1);
	expect(recording.calls).toEqual([]);
	expect(shownPath(todos)).toBe(entry.path);

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
		await todos.open(path, 'files');
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
	await todos.open('a.txt', 'files');
	const first = textEditor(todos);
	await todos.open('b.txt', 'files');
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
			// As the folder's own fetch does: the caller's signal stops that
			// caller waiting, here when close begins.
			options?.signal?.addEventListener('abort', () => resolve(), {
				once: true,
			});
		});
		return Ok({ status: 'fetched', oid: undefined });
	};

	const pulling = todos.pull();
	while (release === undefined) await Bun.sleep(1);
	await close(todos);
	calls.length = 0;
	release();
	expect(expectErr(await pulling).name).toBe('Closed');
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

test('close cancels a pull whose fetch is still on the network, and nothing is fast-forwarded', async () => {
	const originalFetch = globalThis.fetch;
	let requests = 0;
	let aborted = 0;
	// The request ends only when the folder aborts it.
	globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
		requests++;
		return new Promise<Response>((_resolve, reject) =>
			init?.signal?.addEventListener('abort', () => {
				aborted++;
				reject(new DOMException('The fetch was cancelled', 'AbortError'));
			}),
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

		// Close stops waiting for the pull, which applies nothing and says the
		// folder closed; closing the folder then aborts the request itself.
		await close(todos);
		expect(expectErr(await pulling).name).toBe('Closed');
		expect(requests).toBe(1);
		expect(aborted).toBe(1);
		expect(calls).not.toContain('git.pullFastForward');
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('close waits for a terminal script admitted before it, through its last statement, and only then closes the folder', async () => {
	const storage = createTestStorage();
	let hold: PromiseWithResolvers<void> | undefined;
	const held = Promise.withResolvers<void>();
	const folder = expectOk(
		await openFolder({
			id: `todos-test-${count++}`,
			definition: todosDefinition,
			browser: {
				author: { name: 'Test', email: 'test@example.test' },
				commitOnEdit: false,
				opfs: {
					locks: testLocks,
					// The script's first write is held until the test releases it.
					getDirectory: async () =>
						holdCloses(await storage.opfs.getDirectory(), async (file) => {
							const gate = hold;
							if (gate === undefined || file.name !== 'first.txt') return;
							hold = undefined;
							held.resolve();
							await gate.promise;
						}),
				},
			},
		}),
	);
	const { calls, adapt } = recordingFolder();
	const todos = createTodos(adapt(folder));
	await todos.check();
	const release = Promise.withResolvers<void>();
	hold = release;

	todos.terminal.command = 'echo one > first.txt; echo two > second.txt';
	const running = todos.terminal.run();
	await held.promise;
	let closed = false;
	const closing = todos.close().then(() => {
		closed = true;
	});
	await Bun.sleep(20);
	expect(closed).toBe(false);
	expect(calls).not.toContain('close');

	release.resolve();
	await running;
	await closing;
	expect(todos.terminal.runs.at(-1)?.result?.exitCode).toBe(0);
	// The second statement ran after close began, and before the folder closed.
	const stored = opfsOf(storage).files();
	const text = (name: string) => {
		const found = [...stored].find(([key]) => key.endsWith(`/${name}`));
		return found && new TextDecoder().decode(found[1]);
	};
	expect(text('first.txt')).toBe('one\n');
	expect(text('second.txt')).toBe('two\n');
	expect(calls.at(-1)).toBe('close');
});

test('close waits for a terminal git fetch held on the network until the command ends, without cancelling it', async () => {
	const originalFetch = globalThis.fetch;
	let requests = 0;
	const respond = Promise.withResolvers<void>();
	// The request answers only when the test lets it; the terminal's git
	// fetch forwards no signal of the app's, so close cannot cut it short.
	globalThis.fetch = (async () => {
		requests++;
		await respond.promise;
		throw new TypeError('The network is unreachable');
	}) as unknown as typeof fetch;
	try {
		const { calls, adapt } = recordingFolder();
		const todos = await open(adapt, {
			url: 'http://stall.test/remote.git',
			branch: 'main',
		});
		todos.terminal.command = 'git fetch';
		const running = todos.terminal.run();
		for (let waited = 0; waited < 400 && requests === 0; waited++)
			await Bun.sleep(5);
		expect(requests).toBe(1);

		let closed = false;
		const closing = close(todos).then(() => {
			closed = true;
		});
		await Bun.sleep(50);
		expect(closed).toBe(false);
		expect(calls).not.toContain('close');

		respond.resolve();
		await running;
		await closing;
		expect(closed).toBe(true);
		expect(todos.terminal.runs.at(-1)?.result?.exitCode).not.toBe(0);
		expect(calls.at(-1)).toBe('close');
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

test('a missing-file reload keeps accepted input and the notice until deliberate Close', async () => {
	const todos = await open(withoutHints);
	const path = 'todos/milk.md';
	expectOk(await todos.folder.files.create(path, ROW));
	await todos.refresh();
	await todos.open(path, 'todos');
	const editor = todoEditor(todos);
	expect(typeNotes(editor, 'kept\n')).toBeUndefined();
	await written(editor);
	expect(typeNotes(editor, 'kept\uD800')).toContain('not taken');
	await removeNow(todos, path);
	expect(await todos.reload(path)).toContain('could not be read');
	expect(todoEditor(todos)).toBe(editor);
	expect(fieldsOf(editor).body).toBe('kept\n');
	expect(editor.refusal).toBeDefined();
	expect(typeTitle(editor, 'Attempt')).toBeUndefined();
	await written(editor);
	expect(todos.unsaved).toBe(true);
	todos.discard(path);
	expect(todos.current?.item).toBeUndefined();
});

test('a return to Files during a handoff wins after the existing path reservation settles', async () => {
	const todos = await open();
	const path = 'todos/milk.md';
	expectOk(
		await todos.folder.files.create(
			path,
			'---\ntitle: Milk\ndone: false\n---\nNotes.',
		),
	);
	await todos.open(path, 'files');
	const file = textEditor(todos);
	const pending = Promise.withResolvers<void>();
	const settle = file.settle;
	file.settle = async () => {
		await pending.promise;
		return settle();
	};
	const towardTodo = todos.open(path, 'todos');
	const backToFiles = todos.open(path, 'files');
	pending.resolve();
	await Promise.all([towardTodo, backToFiles]);
	expect(todos.current?.workspace).toBe('files');
	expect(textEditor(todos).buffer).toContain('Notes.');
});
