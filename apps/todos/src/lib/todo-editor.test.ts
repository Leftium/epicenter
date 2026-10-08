/**
 * Todo Editor Tests
 *
 * Drives the real todo editor runes module over a real native row editor
 * (`table.edit`) whose storage the test controls: replies can be held,
 * writes can fail, reads can fail, and another writer can change the file.
 * The native editor owns the row and its publication queue; these tests pin what the app adds: admission of complete rows
 * from the fields view, the source preference, view gates, fences, and release.
 *
 * Key behaviors:
 * - Title, done, and notes each submit the complete row at once, unknown
 *   metadata included; one write runs and the latest input follows it
 * - A title change keeps the body byte for byte; the notes control restores
 *   the file's CRLF in the row it sends, and the source view's LF text is
 *   written back in CRLF
 * - Raw and fields modes share one native editor; omitted keys are deleted
 * - A malformed row opens for raw repair, and raw mode stays after the
 *   repair until the person chooses fields
 * - A complete row is taken only while the row shows its fields; source
 *   text only while it shows its source
 * - A failed save keeps input on screen; a later edit or checkbox saves again
 * - Another writer's change is not read in; Reload shows it and ends a
 *   failure, and a read that fails keeps the input
 * - A row the codec cannot take changes nothing and keeps only why: a fresh
 *   notice per refusal, never unsaved input, cleared by accepted input or a
 *   successful Reload. Raw text UTF-8 cannot encode is held and fails on its
 *   turn without a write
 * - Fences, including the person's Reload, refuse input and wait for
 *   admitted writes
 * - A released editor refuses input and commands for good; admitted writes
 *   still publish
 *
 * The fixture table's title needs a character; Todos' own schema allows an
 * empty title. Tests that rely on the stricter rule say so.
 *
 * See also:
 * - `todos.test.ts` for the editors the app retains, renames, and closes
 * - `packages/folder/src/editor.test.ts` for the native queue itself
 */
import './svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { FileError, parseCanonicalDocument } from '@epicenter/folder';
import { withFileNewlines } from '@epicenter/folder/file-browser';
import {
	openTodo,
	todo as row,
} from '../../../../packages/folder/src/svelte/row-storage.test-support.js';
import type { TodoEditor } from './todo-editor.svelte.js';

const { BUSY, createTodoEditor, describeSaveError, RELEASED } = await import(
	'./todo-editor.svelte.ts'
);

const PATH = 'todos/plan.md';
const IN_SOURCE = 'This todo is open in its source editor. Change it there.';
const released: TodoEditor[] = [];

afterEach(() => {
	for (const editor of released.splice(0)) editor.release();
});

/** A todo editor over a controlled native editor on `todos/plan.md`. */
async function setup(initial?: string) {
	const fake = await openTodo(initial);
	const todo = createTodoEditor(PATH, fake.editor);
	released.push(todo);
	return { fake, todo };
}

/** Wait for something the test did not request directly. The assertion follows the wait. */
async function eventually(settled: () => boolean) {
	for (let waited = 0; waited < 400 && !settled(); waited++) await Bun.sleep(5);
}

/** Wait for admitted writes. Answers why the latest did not land. */
async function written(todo: TodoEditor) {
	await todo.settle();
	return todo.save.status === 'failed' ? todo.save.error.name : undefined;
}

/** The complete parse of the file's text now. */
function parsed(text: string | undefined) {
	const { data, error } = parseCanonicalDocument(text ?? '');
	if (error !== null) throw new Error(`Not canonical: ${error.reason}`);
	return data;
}

/** The fields view's current row; it shows only for a valid row. */
function fieldsOf(todo: TodoEditor) {
	const { row } = todo;
	if (row.status !== 'valid') throw new Error('The row shows no fields');
	return row;
}

/** What the title control sends: the complete row on screen with `title`. */
function typeTitle(todo: TodoEditor, title: string) {
	const row = fieldsOf(todo);
	return todo.set({ ...row, fields: { ...row.fields, title } });
}

/** What the notes control sends: the complete row on screen with LF `notes` in the file's newlines. */
function typeNotes(todo: TodoEditor, notes: string) {
	const row = fieldsOf(todo);
	return todo.set({ ...row, body: withFileNewlines(notes, row.text) });
}

/** What the done checkbox sends: the complete row on screen with `done`. */
function check(todo: TodoEditor, done: boolean) {
	const row = fieldsOf(todo);
	return todo.set({ ...row, fields: { ...row.fields, done } });
}

const UNKNOWN = '"owner": "sam"\n"unknown": {"nested": ["one", "two"]}\n';

test('title, done, and notes each submit the complete row at once, unknown metadata included; one write runs and the latest input follows', async () => {
	const { fake, todo } = await setup(row('Plan', 'Body.\n', UNKNOWN));
	fake.holdReplies();

	expect(typeTitle(todo, 'Plan B')).toBeUndefined();
	expect(check(todo, true)).toBeUndefined();
	expect(typeNotes(todo, 'Notes\n')).toBeUndefined();
	// The native editor holds the latest input; the view shows it.
	expect(todo.row).toMatchObject({
		status: 'valid',
		fields: { title: 'Plan B', done: true },
		body: 'Notes\n',
	});
	expect(todo.isSaving).toBe(true);
	await eventually(() => fake.heldReplies() === 1);
	expect(fake.writes).toHaveLength(1);

	fake.releaseReplies();
	expect(await written(todo)).toBeUndefined();
	// The first write, then the latest input; the one between was superseded.
	expect(fake.writes).toHaveLength(2);
	expect(parsed(fake.disk())).toEqual({
		fields: {
			title: 'Plan B',
			done: true,
			owner: 'sam',
			unknown: { nested: ['one', 'two'] },
		},
		body: 'Notes\n',
	});
});

test("a title change keeps the body byte for byte; notes and source sent in LF keep the file's CRLF", async () => {
	const body = 'Line one\r\nLine two\r\n';
	const { fake, todo } = await setup(row('Plan', body));
	expect(fieldsOf(todo).body).toBe(body);

	typeTitle(todo, 'Plan B');
	expect(await written(todo)).toBeUndefined();
	expect(parsed(fake.disk()).body).toBe(body);

	typeNotes(todo, 'Line one\nLine two\nLine three\n');
	expect(await written(todo)).toBeUndefined();
	expect(parsed(fake.disk()).body).toBe(
		'Line one\r\nLine two\r\nLine three\r\n',
	);

	// The source view shows LF and writes the file's convention back.
	expect(todo.editSource()).toBeUndefined();
	const shown = todo.row.text.replace(/\r\n/g, '\n');
	todo.setText(shown.replace('Line three', 'Line 3'));
	expect(await written(todo)).toBeUndefined();
	expect(fake.disk()).toBe(
		shown.replace('Line three', 'Line 3').replace(/\n/g, '\r\n'),
	);
});

test('raw and fields edits share one native editor: unknown metadata stays, and an omitted key is deleted', async () => {
	const { fake, todo } = await setup(row('Plan', 'Body.\n', UNKNOWN));

	expect(todo.editSource()).toBeUndefined();
	expect(todo.rawMode).toBe(true);
	todo.setText(
		todo.row.text.replace('"owner": "sam"\n', '').replace('"Plan"', '"Plan B"'),
	);
	expect(await written(todo)).toBeUndefined();
	expect(parsed(fake.disk()).fields).toEqual({
		title: 'Plan B',
		done: false,
		unknown: { nested: ['one', 'two'] },
	});

	expect(todo.editFields()).toBeUndefined();
	expect(todo.rawMode).toBe(false);
	// The fields view composes from the raw edit's row.
	typeTitle(todo, 'Plan C');
	expect(await written(todo)).toBeUndefined();
	expect(parsed(fake.disk())).toEqual({
		fields: {
			title: 'Plan C',
			done: false,
			unknown: { nested: ['one', 'two'] },
		},
		body: 'Body.\n',
	});
});

test('a malformed row opens for raw repair; raw mode stays after the repair until the person chooses fields', async () => {
	const { fake, todo } = await setup('---\ntitle: *missing\n---\n');
	expect(todo.row.status).toBe('invalid');
	expect(todo.diagnostics()?.summary).toContain('cannot be edited as fields');
	expect(todo.editFields()).toContain('does not read as a todo');

	// No fields view exists for an invalid row, so a complete row is refused.
	expect(todo.set({ fields: { title: 'Typed', done: true }, body: '' })).toBe(
		IN_SOURCE,
	);
	expect(todo.row.text).toBe('---\ntitle: *missing\n---\n');

	todo.setText('---\ntitle: Fixed\ndone: false\n---\n');
	expect(todo.rawMode).toBe(true);
	expect(await written(todo)).toBeUndefined();
	expect(fake.disk()).toBe('---\ntitle: Fixed\ndone: false\n---\n');
	expect(todo.row.status).toBe('valid');
	expect(todo.rawMode).toBe(true);

	expect(todo.editFields()).toBeUndefined();
	expect(fieldsOf(todo).fields.title).toBe('Fixed');
});

test("under the fixture's stricter schema, where a title needs a character (the Todos schema allows an empty one), schema-invalid fields input is saved and the row moves to raw repair with no partial form", async () => {
	const { fake, todo } = await setup();
	// This fixture table's title needs at least one character; Todos' does not.
	expect(typeTitle(todo, '')).toBeUndefined();
	expect(await written(todo)).toBeUndefined();
	expect(parsed(fake.disk()).fields.title).toBe('');
	expect(todo.row.status).toBe('invalid');
	expect(todo.refusal).toBeUndefined();
	expect(todo.diagnostics()?.details.length).toBeGreaterThan(0);
	// The raw view takes the repair; a complete row is refused.
	const before = todo.row.text;
	const document = parsed(before);
	expect(
		todo.set({ ...document, fields: { ...document.fields, title: 'ignored' } }),
	).toBe(IN_SOURCE);
	expect(todo.row.text).toBe(before);
	todo.setText(before.replace('"title": ""', '"title": "Back"'));
	expect(await written(todo)).toBeUndefined();
	expect(parsed(fake.disk()).fields.title).toBe('Back');
});

test('a leaving view admits nothing: raw input outside raw mode, and fields input in raw mode', async () => {
	const { fake, todo } = await setup();
	const before = todo.row.text;

	todo.setText('junk');
	expect(todo.row.text).toBe(before);

	expect(todo.editSource()).toBeUndefined();
	expect(typeTitle(todo, 'ignored')).toBe(IN_SOURCE);
	expect(typeNotes(todo, 'ignored')).toBe(IN_SOURCE);
	expect(check(todo, true)).toBe(IN_SOURCE);
	expect(todo.refusal).toBeUndefined();
	expect(todo.row.text).toBe(before);
	expect(fake.writes).toEqual([]);
});

test('a failed save keeps input on screen and the list checkbox saves the complete row again', async () => {
	const { fake, todo } = await setup();
	fake.script('io');
	typeTitle(todo, 'A');
	expect(await written(todo)).toBe('Io');
	expect(todo.hasProblem).toBe(true);
	expect(fake.writes).toEqual([]);

	expect(await todo.toggle(true)).toBeUndefined();
	expect(todo.row).toMatchObject({ fields: { title: 'A', done: true } });
	expect(await written(todo)).toBeUndefined();
	expect(todo.isIdle).toBe(true);
	expect(fake.writes.map((text) => parsed(text).fields.title)).toEqual(['A']);
});

test('Try again writes the exact text on screen: a comment and quoting stay', async () => {
	const commented =
		"---\n# kept by sam\ntitle: 'Plan'\ndone: false\n---\nBody.\n";
	const { fake, todo } = await setup(commented);
	expect(todo.row.status).toBe('valid');
	expect(todo.editSource()).toBeUndefined();
	const typed = commented.replace("'Plan'", "'Plan B' # renamed");
	fake.script('io');
	todo.setText(typed);
	expect(await written(todo)).toBe('Io');
	expect(todo.row).toMatchObject({ status: 'valid', text: typed });

	expect(todo.retry()).toBeUndefined();
	expect(await written(todo)).toBeUndefined();
	expect(fake.disk()).toBe(typed);
});

test("an unconfirmed save is described as uncertain and keeps the folder's own detail", () => {
	const error = FileError.Unconfirmed({
		path: PATH,
		operation: 'replace',
		cause: new Error('displaced file kept at .git/epicenter/scratch/plan-1'),
	}).error;
	const message = describeSaveError(error);
	expect(message).toContain('may or may not be in the file');
	expect(message).toContain('.git/epicenter/scratch/plan-1');
});

test("another writer's change is not read in: the next edit writes the complete row over it, and Reload shows it instead", async () => {
	const { fake, todo } = await setup();
	fake.writeElsewhere(row('Theirs'));
	expect(fieldsOf(todo).fields.title).toBe('Plan');
	typeNotes(todo, 'mine\n');
	expect(await written(todo)).toBeUndefined();
	expect(parsed(fake.disk())).toMatchObject({
		fields: { title: 'Plan' },
		body: 'mine\n',
	});

	fake.writeElsewhere(row('Theirs again'));
	expect(await todo.reload()).toMatchObject({ error: null });
	expect(fieldsOf(todo).fields.title).toBe('Theirs again');
	expect(fake.disk()).toBe(row('Theirs again'));
});

test('Reload after a failed save adopts the file and ends the failure; a read that fails keeps the input', async () => {
	const { fake, todo } = await setup();
	fake.script('io');
	typeTitle(todo, 'Mine');
	expect(await written(todo)).toBe('Io');

	fake.failReads(
		FileError.Io({ path: PATH, operation: 'read', cause: 'busy' }).error,
	);
	expect((await todo.reload()).error?.name).toBe('Io');
	expect(fieldsOf(todo).fields.title).toBe('Mine');
	expect(todo.hasProblem).toBe(true);

	fake.failReads(undefined);
	expect((await todo.reload()).error).toBeNull();
	expect(fieldsOf(todo).fields.title).toBe('Plan');
	expect(todo.isIdle).toBe(true);
	expect(fake.writes).toEqual([]);
});

test('a row the codec cannot take changes nothing and keeps only why, a new notice each time; it holds nothing up and clears on accepted input or Reload', async () => {
	const { fake, todo } = await setup();
	const before = todo.row;
	expect(typeNotes(todo, 'a\uD800b')).toContain('not taken');
	expect(todo.row).toBe(before);
	const first = todo.refusal;
	expect(first?.reason).toContain('lone surrogate');
	expect(todo.isIdle).toBe(true);
	expect(todo.hasProblem).toBe(false);
	expect(fake.writes).toEqual([]);

	// The same refusal again is a new notice with the same reason.
	expect(typeNotes(todo, 'a\uD800b')).toContain('not taken');
	expect(todo.refusal).not.toBe(first);
	expect(todo.refusal?.reason).toBe(first?.reason);

	// Nothing waits on it: settling, a fence, a departure, and the source view.
	expect(await todo.settle()).toBe(true);
	expect(await todo.fence(async (settled) => settled)).toBe(true);
	todo.prepareDeparture();
	expect(await todo.drainDeparture()).toBe(true);
	todo.resumeDeparture();
	expect(todo.editSource()).toBeUndefined();
	expect(todo.editFields()).toBeUndefined();
	expect(todo.refusal).toBeDefined();

	// Accepted input clears it and saves the row the controls showed.
	expect(typeTitle(todo, 'Plan B')).toBeUndefined();
	expect(todo.refusal).toBeUndefined();
	expect(await written(todo)).toBeUndefined();
	expect(parsed(fake.disk())).toEqual({
		fields: { title: 'Plan B', done: false },
		body: 'Body.\n',
	});

	// A failed save and a later refusal are both kept; neither replaces the other.
	fake.script('io');
	typeTitle(todo, 'Mine');
	expect(await written(todo)).toBe('Io');
	expect(typeTitle(todo, 'x\uD800')).toContain('not taken');
	expect(todo.save.status).toBe('failed');
	expect(todo.refusal).toBeDefined();
	expect(fieldsOf(todo).fields.title).toBe('Mine');

	// A deliberate Reload ends both and shows the file.
	expect((await todo.reload()).error).toBeNull();
	expect(todo.refusal).toBeUndefined();
	expect(fieldsOf(todo).fields.title).toBe('Plan B');
	expect(todo.isIdle).toBe(true);
});

test('raw text UTF-8 cannot encode exactly is held by the native editor and fails on its turn without a write; corrected input writes it', async () => {
	const { fake, todo } = await setup();
	expect(todo.editSource()).toBeUndefined();
	const valid = todo.row.text;
	todo.setText(`${valid}\uD800`);
	expect(await written(todo)).toBe('Unencodable');
	expect(todo.row).toMatchObject({
		status: 'invalid',
		error: { name: 'Unencodable' },
	});
	expect(todo.diagnostics()?.summary).toContain('cannot be saved exactly');
	expect(fake.writes).toEqual([]);

	todo.setText(`${valid}fixed\n`);
	expect(await written(todo)).toBeUndefined();
	expect(fake.disk()).toBe(`${valid}fixed\n`);
});

test('a fence refuses input and waits for admitted writes; a failure leaves it unsettled', async () => {
	const { fake, todo } = await setup();
	fake.holdReplies();
	typeTitle(todo, 'A');
	let ran = false;
	const fenced = todo.fence(async (settled) => {
		ran = true;
		return settled;
	});
	expect(todo.isFenced).toBe(true);
	expect(typeTitle(todo, 'ignored')).toBe(BUSY);
	expect(fieldsOf(todo).fields.title).toBe('A');
	expect(todo.retry()).toBe(BUSY);
	await Bun.sleep(10);
	expect(ran).toBe(false);
	fake.releaseReplies();
	expect(await fenced).toBe(true);
	expect(todo.isFenced).toBe(false);
	expect(parsed(fake.disk()).fields.title).toBe('A');

	fake.script('io');
	typeTitle(todo, 'B');
	expect(await todo.fence(async (settled) => settled)).toBe(false);
	expect(todo.hasProblem).toBe(true);
	// Newer input starts a save; the fence waits for it without another retry.
	typeTitle(todo, 'C');
	expect(await todo.fence(async (settled) => settled)).toBe(true);
	expect(parsed(fake.disk()).fields.title).toBe('C');
});

test('release refuses later input, holds no subscription, and an admitted write still publishes', async () => {
	const { fake, todo } = await setup();
	// The editor watches no save of its own; the listings hear the folder.
	expect(fake.subscriptions()).toBe(0);
	fake.holdReplies();
	typeTitle(todo, 'A');
	todo.release();
	expect(typeTitle(todo, 'B')).toBe(RELEASED);
	fake.releaseReplies();
	expect(await written(todo)).toBeUndefined();
	expect(fake.writes.map((text) => parsed(text).fields.title)).toEqual(['A']);
});

test('a released editor refuses input and commands for good, even after the fence around its release unwinds', async () => {
	const { fake, todo } = await setup();
	expect(todo.editSource()).toBeUndefined();
	// Released inside a fence, as a rename releases the source's editor.
	await todo.fence(async () => {
		todo.release();
	});
	expect(todo.isFenced).toBe(true);
	todo.setText('---\ntitle: Late\ndone: false\n---\n');
	expect(todo.editFields()).toBe(RELEASED);
	expect(typeTitle(todo, 'Late')).toBe(RELEASED);
	expect(typeNotes(todo, 'late\n')).toBe(RELEASED);
	expect(check(todo, true)).toBe(RELEASED);
	expect(todo.retry()).toBe(RELEASED);
	expect(await todo.toggle(true)).toBe(RELEASED);
	expect(todo.editSource()).toBe(RELEASED);
	expect(fake.writes).toEqual([]);
	expect(todo.isIdle).toBe(true);
});

test('close refuses input, waits for the write, and leaves no subscription', async () => {
	const { fake, todo } = await setup();
	fake.holdReplies();
	typeTitle(todo, 'Last');
	const closing = todo.close();
	expect(typeTitle(todo, 'ignored')).toBe(BUSY);
	await Bun.sleep(10);
	fake.releaseReplies();
	expect(await closing).toBe(true);
	expect(parsed(fake.disk()).fields.title).toBe('Last');
	expect(fake.subscriptions()).toBe(0);
});

test("the person's Reload fences input while it reads, and a successful one clears the notice", async () => {
	const { fake, todo } = await setup();
	fake.holdReplies();
	typeTitle(todo, 'Saved title');
	await eventually(() => fake.heldReplies() > 0);
	expect(typeNotes(todo, 'bad\uD800')).toContain('not taken');
	const reloading = todo.reload();
	expect(todo.isFenced).toBe(true);
	expect(typeTitle(todo, 'late')).toBe(BUSY);
	expect(fieldsOf(todo).fields.title).toBe('Saved title');
	fake.releaseReplies();
	expect((await reloading).error).toBeNull();
	expect(todo.isFenced).toBe(false);
	expect(todo.refusal).toBeUndefined();
});
