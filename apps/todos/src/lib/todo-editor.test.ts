/**
 * Todo Editor Tests
 *
 * Drives the real todo editor runes module over a real native row editor
 * (`table.edit`) whose storage the test controls: replies can be held,
 * writes can fail, reads can fail, and another writer can change the file.
 * The native editor owns the row and its publication queue; these tests pin what the app adds: admission of complete rows,
 * why a row was not taken, fences, and release.
 *
 * Key behaviors:
 * - Title, done, and notes each submit the complete row at once, unknown
 *   metadata included; one write runs and the latest input follows it
 * - A title change keeps the body byte for byte; the notes control restores
 *   the file's CRLF in the row it sends
 * - A complete row replaces the whole row: a spread keeps unknown metadata,
 *   and an omitted key is deleted
 * - A row that does not read as a todo keeps its editor and text and says
 *   why; the checkbox has no `done` to change, and a complete row composed
 *   elsewhere is still taken, since no view mode gates input
 * - A failed save keeps input on screen; a later edit or checkbox saves again
 * - Another writer's change is not read in; Reload shows it and ends a
 *   failure, and a read that fails keeps the input
 * - A row the codec cannot take changes nothing and keeps only why: a fresh
 *   notice per refusal, never unsaved input, cleared by accepted input or a
 *   successful Reload
 * - Fences refuse input and wait for admitted writes. The person's Reload
 *   is not one: typing while it is pending stands, and it answers
 *   InputChanged
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

const { BUSY, createTodoEditor, describeSaveError, RELEASED } =
	await import('./todo-editor.svelte.ts');

const PATH = 'todos/plan.md';
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

test("a title change keeps the body byte for byte; notes sent in LF keep the file's CRLF", async () => {
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
});

test('a complete row replaces the whole row: a spread keeps unknown metadata, and an omitted key is deleted', async () => {
	const { fake, todo } = await setup(row('Plan', 'Body.\n', UNKNOWN));

	typeTitle(todo, 'Plan B');
	expect(await written(todo)).toBeUndefined();
	expect(parsed(fake.disk()).fields).toEqual({
		title: 'Plan B',
		done: false,
		owner: 'sam',
		unknown: { nested: ['one', 'two'] },
	});

	const { owner: _, ...kept } = fieldsOf(todo).fields;
	expect(todo.set({ ...fieldsOf(todo), fields: kept })).toBeUndefined();
	expect(await written(todo)).toBeUndefined();
	expect(parsed(fake.disk())).toEqual({
		fields: {
			title: 'Plan B',
			done: false,
			unknown: { nested: ['one', 'two'] },
		},
		body: 'Body.\n',
	});
});

test('a malformed row keeps its editor and exact text and says why; the checkbox has nothing to change, and no view mode refuses a complete row', async () => {
	const malformed = '---\ntitle: *missing\n---\n';
	const { fake, todo } = await setup(malformed);
	expect(todo.row).toMatchObject({ status: 'invalid', text: malformed });
	expect(todo.diagnostics()?.summary).toContain('cannot be edited as fields');
	expect(await todo.toggle(true)).toContain('Open it in Files');
	expect(fake.writes).toEqual([]);

	// Narrowing to read fields is the controls' business, not admission's: a
	// complete row composed without the invalid one is taken and written.
	expect(
		todo.set({ fields: { title: 'Typed', done: true }, body: '' }),
	).toBeUndefined();
	expect(await written(todo)).toBeUndefined();
	expect(parsed(fake.disk()).fields).toEqual({ title: 'Typed', done: true });
	expect(fieldsOf(todo).fields.title).toBe('Typed');
});

test("under the fixture's stricter schema, where a title needs a character (the Todos schema allows an empty one), schema-invalid fields input is saved, the row reads as needing repair with no partial form, and Reload of a repaired file shows its fields", async () => {
	const { fake, todo } = await setup();
	// This fixture table's title needs at least one character; Todos' does not.
	expect(typeTitle(todo, '')).toBeUndefined();
	expect(await written(todo)).toBeUndefined();
	expect(parsed(fake.disk()).fields.title).toBe('');
	expect(todo.row.status).toBe('invalid');
	expect(todo.refusal).toBeUndefined();
	expect(todo.diagnostics()?.details.length).toBeGreaterThan(0);
	expect(() => fieldsOf(todo)).toThrow();

	// Repaired in Files, by another writer as far as this editor knows.
	fake.writeElsewhere(row('Back'));
	expect((await todo.reload()).error).toBeNull();
	expect(fieldsOf(todo).fields.title).toBe('Back');
	expect(todo.diagnostics()).toBeUndefined();
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

test('Try again writes the exact text the todo holds, without changing it', async () => {
	const { fake, todo } = await setup(row('Plan', 'Body.\n', UNKNOWN));
	fake.script('io');
	typeTitle(todo, 'Plan B');
	expect(await written(todo)).toBe('Io');
	const held = todo.row.text;
	expect(fake.writes).toEqual([]);

	expect(todo.retry()).toBeUndefined();
	expect(await written(todo)).toBeUndefined();
	expect(fake.disk()).toBe(held);
	expect(todo.row.text).toBe(held);
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

	// Nothing waits on it: settling, a fence, and a departure.
	expect(await todo.settle()).toBe(true);
	expect(await todo.fence(async (settled) => settled)).toBe(true);
	todo.prepareDeparture();
	expect(await todo.drainDeparture()).toBe(true);
	todo.resumeDeparture();
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
	// Released inside a fence, as a rename or a handoff to Files releases it.
	await todo.fence(async () => {
		todo.release();
	});
	expect(todo.isFenced).toBe(true);
	expect(typeTitle(todo, 'Late')).toBe(RELEASED);
	expect(typeNotes(todo, 'late\n')).toBe(RELEASED);
	expect(check(todo, true)).toBe(RELEASED);
	expect(todo.retry()).toBe(RELEASED);
	expect(await todo.toggle(true)).toBe(RELEASED);
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

test("the person's Reload takes typing while it is pending: newer accepted input stands and the reload answers InputChanged; a successful one clears the notice", async () => {
	const { fake, todo } = await setup();
	fake.holdReplies();
	typeTitle(todo, 'Saved title');
	await eventually(() => fake.heldReplies() > 0);
	const reloading = todo.reload();
	expect(todo.isFenced).toBe(false);
	expect(typeTitle(todo, 'Newer')).toBeUndefined();
	fake.releaseReplies();
	expect((await reloading).error?.name).toBe('InputChanged');
	expect(fieldsOf(todo).fields.title).toBe('Newer');
	expect(await written(todo)).toBeUndefined();
	expect(parsed(fake.disk()).fields.title).toBe('Newer');

	expect(typeNotes(todo, 'bad\uD800')).toContain('not taken');
	expect((await todo.reload()).error).toBeNull();
	expect(todo.refusal).toBeUndefined();
	expect(fieldsOf(todo).fields.title).toBe('Newer');
});
