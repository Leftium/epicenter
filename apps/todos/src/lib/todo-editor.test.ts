/**
 * Todo Editor Tests
 *
 * Drives the real todo editor runes module over the folder's own row editor
 * (`table.edit`) in a browser folder on fake IndexedDB. The row editor owns
 * the canonical draft and its unconditional save; these tests pin the app's
 * policy around it: autosave, halting, review, and rename.
 *
 * Key behaviors:
 * - Title, done, and notes change one draft, and autosave writes the
 *   complete canonical document once after a pause
 * - Fields that do not conform stay in the draft; nothing is saved, and
 *   fixing them saves
 * - A failed save halts autosave until an explicit save renews it; a save
 *   whose storage threw halts the same way, and disposal still resolves
 * - A lost save reply stays unknown after a read finds its text, and halts
 *   autosave the same way
 * - Another writer's change never replaces input and holds autosave; only
 *   an explicit save replaces their text, and discarding mine loads it
 *   without writing
 * - The read that predates the editor's own save receipt is not another
 *   writer's change: input typed during the save autosaves next
 * - A removed file is written again by the draft's save
 * - A save captures the draft: input during it stays unsaved and saves next
 * - A rename holds saves, carries input typed during the move to the
 *   destination's editor, disposes the old one, and writes nothing at the
 *   old path
 *
 * See also:
 * - `editor.test.ts` for raw text and row source drafts
 * - `todos.test.ts` for the editors the app retains, renames, and closes
 */
import './svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import type { RowEditor } from '@epicenter/folder';
import { FileError } from '@epicenter/folder';
import { openFolder } from '@epicenter/folder/browser';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { expectOk } from 'wellcrafted/testing';
import { type TodoFields, todosDefinition } from './definition.js';
import type { TodoEditor } from './todo-editor.svelte.js';

const { createTodoEditor } = await import('./todo-editor.svelte.ts');

const ROW = '---\ntitle: Milk\ndone: false\n---\n';
const PATH = 'todos/milk.md';
let count = 0;
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

type Row = RowEditor<TodoFields>;

/**
 * A todo editor on `todos/milk.md`. `wrap` stands between the todo editor
 * and the folder's row editor, so a test can change what a save answers.
 */
async function setup(wrap: (row: Row) => Row = (row) => row) {
	const folder = expectOk(
		await openFolder({
			id: `todo-editor-test-${count++}`,
			definition: todosDefinition,
			browser: {
				commitOnEdit: false,
				indexedDb: { indexedDB: new IDBFactory(), IDBKeyRange },
			},
		}),
	);
	cleanup.push(() => folder.close());
	expectOk(await folder.files.create(PATH, ROW));
	const table = folder.tables.todos;
	const row = expectOk(await table.edit('milk'));
	const saved = { count: 0 };
	const editor: TodoEditor = createTodoEditor(table, wrap(row), () => {
		saved.count++;
	});
	cleanup.push(() => editor.dispose());
	/** The file's text now, or undefined when nothing is at the path. */
	async function text(path = PATH) {
		const read = await folder.files.read(path);
		return read.error ? undefined : new TextDecoder().decode(read.data.bytes);
	}
	/** How the file now reads as a todo. */
	async function reading(path = PATH) {
		return table.inspect((await text(path)) ?? '');
	}
	return { folder, table, row, editor, saved, text, reading };
}

/** Wait for an autosave the test did not request. The assertion follows the wait. */
async function eventually(settled: () => boolean) {
	for (let waited = 0; waited < 400 && !settled(); waited++) await Bun.sleep(5);
}

/** Longer than the typing batch, so a save that was going to start has started. */
const pastTypingBatch = () => Bun.sleep(450);

test('title, done, and notes change one draft, and autosave writes the complete canonical document once', async () => {
	const { editor, saved, text, reading } = await setup();

	expect(editor.change({ fields: { title: 'Oat milk' } })).toBeUndefined();
	expect(editor.change({ fields: { done: true } })).toBeUndefined();
	expect(editor.change({ body: 'Notes\n' })).toBeUndefined();
	expect(editor.state.isDirty).toBe(true);
	expect(await text()).toBe(ROW);

	await eventually(() => editor.isIdle);
	expect(saved.count).toBe(1);
	expect(await text()).toBe(editor.state.source);
	expect(await reading()).toEqual({
		fields: { title: 'Oat milk', done: true },
		body: 'Notes\n',
		parseError: undefined,
		issues: [],
	});
});

test('fields that do not conform stay in the draft and are not saved until fixed', async () => {
	const { editor, text, reading } = await setup();

	expect(editor.change({ fields: { done: 'soon' } })).toBeUndefined();
	expect(editor.state.document.fields.done).toBe('soon');
	expect(editor.state.reading.issues.map((issue) => issue.field)).toEqual([
		'done',
	]);
	expect(editor.hasProblem).toBe(true);
	expect(await editor.save()).toContain('need fixing');
	await pastTypingBatch();
	expect(await editor.settle()).toBe(false);
	expect(await text()).toBe(ROW);
	expect(editor.state.document.fields.done).toBe('soon');

	editor.change({ fields: { done: true } });
	expect(await editor.settle()).toBe(true);
	expect((await reading()).fields).toEqual({ title: 'Milk', done: true });
});

test('a failed save halts autosave until an explicit save renews it', async () => {
	let failures = 1;
	const { editor, reading } = await setup((row) => ({
		...row,
		save: () =>
			failures-- > 0
				? Promise.resolve(
						FileError.Io({
							path: PATH,
							operation: 'write',
							cause: new Error('disk full'),
						}),
					)
				: row.save(),
	}));

	editor.change({ body: 'mine\n' });
	expect(await editor.save()).toContain('disk full');
	expect(editor.halt).toEqual({
		kind: 'failed',
		operation: 'save',
		message: expect.stringContaining('disk full'),
	});
	editor.change({ body: 'mine and more\n' });
	await pastTypingBatch();
	expect((await reading()).body).toBe('');
	expect(editor.state.document.body).toBe('mine and more\n');
	expect(editor.isDiscardable).toBe(true);
	expect(await editor.settle()).toBe(false);

	expect(await editor.save()).toBeUndefined();
	expect(editor.halt).toBeUndefined();
	expect(editor.isIdle).toBe(true);
	expect((await reading()).body).toBe('mine and more\n');
});

test('a save whose storage threw halts with the input kept, and disposal still resolves', async () => {
	const { editor, reading } = await setup((row) => ({
		...row,
		save: () => Promise.reject(new Error('storage bug')),
		// The folder's editor rejects its disposal after a save that threw.
		dispose: async () => {
			await row.dispose();
			throw new Error('storage bug');
		},
	}));

	editor.change({ body: 'mine\n' });
	expect(await editor.save()).toBe('storage bug');
	expect(editor.halt).toEqual({
		kind: 'failed',
		operation: 'save',
		message: 'storage bug',
	});
	expect(editor.isSaving).toBe(false);
	expect(editor.state.document.body).toBe('mine\n');
	await pastTypingBatch();
	expect((await reading()).body).toBe('');
	expect(await editor.settle()).toBe(false);
	expect(await editor.dispose()).toBeUndefined();
});

test('a lost save reply stays unknown after a read finds its text, and autosave waits for an explicit save', async () => {
	let lose = 1;
	const { folder, editor, reading } = await setup((row) => ({
		...row,
		async save() {
			if (lose-- <= 0) return row.save();
			// The bytes land, but the reply that would confirm them never arrives.
			expectOk(await folder.files.overwrite(PATH, row.get().source));
			return FileError.Unconfirmed({
				path: PATH,
				operation: 'write',
				cause: new Error('the reply was lost'),
			});
		},
	}));

	editor.change({ body: 'mine\n' });
	expect(await editor.save()).toContain('may or may not');
	await editor.refresh();
	// The file holds the draft's content, so nothing is unsaved. That read
	// cannot say who wrote it, so the save is still unknown.
	expect(editor.state.isDirty).toBe(false);
	expect(editor.halt?.kind).toBe('unknown');
	expect(editor.isIdle).toBe(false);
	expect(editor.hasProblem).toBe(true);

	editor.change({ body: 'more\n' });
	await pastTypingBatch();
	expect((await reading()).body).toBe('mine\n');

	expect(await editor.save()).toBeUndefined();
	expect(editor.halt).toBeUndefined();
	expect((await reading()).body).toBe('more\n');
});

test("another writer's change never replaces input, holds autosave, and an explicit save replaces their text", async () => {
	const { folder, editor, text } = await setup();

	editor.change({ body: 'mine\n' });
	expectOk(await folder.files.overwrite(PATH, `${ROW}theirs\n`));
	await editor.refresh();
	expect(editor.state.document.body).toBe('mine\n');
	expect(editor.externalChange?.kind).toBe('present');
	expect(editor.isAwaitingReview).toBe(true);
	expect(editor.hasProblem).toBe(true);
	expect(editor.isDiscardable).toBe(true);

	await pastTypingBatch();
	expect(await editor.settle()).toBe(false);
	expect(await text()).toBe(`${ROW}theirs\n`);

	expect(await editor.save()).toBeUndefined();
	expect(await text()).toBe(editor.state.source);
	expect(await text()).not.toContain('theirs');
	expect(editor.isAwaitingReview).toBe(false);
});

test('its own save receipt with newer input is not a change made elsewhere: the newer input autosaves', async () => {
	const { editor, reading } = await setup();

	editor.change({ body: 'A\n' });
	const saving = editor.save();
	editor.change({ body: 'A and B\n' });
	expect(await saving).toBeUndefined();
	// The latest read predates the receipt, so it has other bytes than the
	// new baseline. The editor wrote them; it is not a review.
	const { observation, baseline } = editor.state;
	expect(
		observation.kind === 'present' &&
			observation.revision.sha256 !== baseline.sha256,
	).toBe(true);
	expect(editor.externalChange).toBeUndefined();
	expect(editor.isAwaitingReview).toBe(false);

	await eventually(() => editor.isIdle);
	expect((await reading()).body).toBe('A and B\n');
});

test('discarding mine loads the latest read and writes nothing', async () => {
	const { folder, editor, text } = await setup();

	editor.change({ body: 'mine\n' });
	expectOk(await folder.files.overwrite(PATH, `${ROW}theirs\n`));
	await editor.refresh();
	expect(editor.adopt()).toBeUndefined();
	expect(editor.state.document.body).toBe('theirs\n');
	expect(editor.isIdle).toBe(true);
	await pastTypingBatch();
	expect(await text()).toBe(`${ROW}theirs\n`);
});

test('a draft whose file was removed elsewhere writes the row again when it saves', async () => {
	const { folder, editor, text } = await setup();

	editor.change({ body: 'mine\n' });
	expectOk(await folder.files.remove(expectOk(await folder.files.read(PATH))));
	await editor.refresh();
	expect(editor.state.observation.kind).toBe('missing');
	expect(editor.isDiscardable).toBe(true);

	expect(await editor.save()).toBeUndefined();
	expect(await text()).toBe(editor.state.source);
	expect(editor.state.document.body).toBe('mine\n');
});

test('a save captures the draft: input during it stays unsaved and saves next', async () => {
	const reply = Promise.withResolvers<void>();
	const { editor, reading } = await setup((row) => ({
		...row,
		async save() {
			const saved = row.save();
			await reply.promise;
			return saved;
		},
	}));

	editor.change({ body: 'A\n' });
	const saving = editor.save();
	editor.change({ body: 'A and B\n' });
	reply.resolve();
	expect(await saving).toBeUndefined();
	expect((await reading()).body).toBe('A\n');
	expect(editor.state.isDirty).toBe(true);

	expect(await editor.settle()).toBe(true);
	expect((await reading()).body).toBe('A and B\n');
});

test('a rename holds saves, carries input typed during the move to the destination, and writes nothing at the old path', async () => {
	const { table, row, editor, text, reading } = await setup();
	const rename = table.rename.bind(table);
	let release: (() => void) | undefined;
	// The move lands; its reply is held.
	table.rename = async (...args) => {
		const renamed = await rename(...args);
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		return renamed;
	};

	const moving = editor.move('oat');
	while (release === undefined) await Bun.sleep(1);
	editor.change({ body: 'typed during\n' });
	expect(await editor.save()).toBeUndefined();
	await pastTypingBatch();
	expect(await text(PATH)).toBeUndefined();
	expect(await text('todos/oat.md')).toBe(ROW);

	release();
	expect(expectOk((await moving)!).row.path).toBe('todos/oat.md');
	expect(editor.path).toBe('todos/oat.md');
	expect(row.get().isDisposed).toBe(true);
	expect(editor.state.document.body).toBe('typed during\n');
	expect(await editor.settle()).toBe(true);
	expect((await reading('todos/oat.md')).body).toBe('typed during\n');
	expect(await text(PATH)).toBeUndefined();
});
