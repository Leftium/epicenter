/**
 * Todo Editor Tests
 *
 * Drives the real todo editor runes module over a real native row editor
 * (`table.edit`) whose storage the test controls: replies can be held,
 * writes can fail, reads can fail, and another writer can change the file.
 * The native editor owns the row, its publication queue, and its pause after
 * a failure; these tests pin what the app adds: complete rows from the
 * fields view, the source preference, view gates, fences, and release.
 *
 * Key behaviors:
 * - Title, done, and notes each submit the complete row at once, unknown
 *   metadata included; one write runs and the latest input follows it
 * - A title change keeps the body byte for byte; textareas show LF and
 *   setters write back the file's CRLF
 * - Raw and fields modes share one native editor; omitted keys are deleted
 * - A malformed row opens for raw repair, and raw mode stays after the
 *   repair until the person chooses fields
 * - Each setter admits input only while its own view's gate holds
 * - A failed save keeps newer input on screen and writes nothing until
 *   Try again, which writes the exact latest text, comments included
 * - Another writer's change is not read in; Reload shows it and ends a
 *   failure, and a read that fails keeps the input
 * - A title or notes value the row cannot take stays in its field with why,
 *   counts as unsaved through fences and departures, and clears on a valid
 *   value or Reload; raw text UTF-8 cannot encode is held and fails on its
 *   turn without a write
 * - Fences refuse input and wait for admitted writes; a hold refuses input
 *   while its work runs, then reads the row again
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
import {
	openTodo,
	todo as row,
} from '../../../../packages/folder/src/svelte/row-storage.test-support.js';
import type { TodoEditor } from './todo-editor.svelte.js';

const { BUSY, createTodoEditor, describeSaveError, RELEASED } = await import(
	'./todo-editor.svelte.ts'
);

const PATH = 'todos/plan.md';
const released: TodoEditor[] = [];

afterEach(() => {
	for (const editor of released.splice(0)) editor.release();
});

/** A todo editor over a controlled native editor on `todos/plan.md`. */
async function setup(initial?: string) {
	const fake = await openTodo(initial);
	const saved = { count: 0 };
	const todo = createTodoEditor(PATH, fake.editor, () => {
		saved.count++;
	});
	released.push(todo);
	return { fake, todo, saved };
}

/** Wait for something the test did not request directly. The assertion follows the wait. */
async function eventually(settled: () => boolean) {
	for (let waited = 0; waited < 400 && !settled(); waited++) await Bun.sleep(5);
}

/** Wait for admitted writes. Answers why the latest did not land. */
async function written(todo: TodoEditor) {
	const { error } = await todo.editor.flush();
	return error === null ? undefined : error.name;
}

/** The complete parse of the file's text now. */
function parsed(text: string | undefined) {
	const { data, error } = parseCanonicalDocument(text ?? '');
	if (error !== null) throw new Error(`Not canonical: ${error.reason}`);
	return data;
}

const UNKNOWN = '"owner": "sam"\n"unknown": {"nested": ["one", "two"]}\n';

test('title, done, and notes each submit the complete row at once, unknown metadata included; one write runs and the latest input follows', async () => {
	const { fake, todo, saved } = await setup(row('Plan', 'Body.\n', UNKNOWN));
	fake.holdReplies();

	todo.setTitle('Plan B');
	todo.setDone(true);
	todo.setNotes('Notes\n');
	// The native editor holds the latest input; the view shows it.
	expect(todo.title()).toBe('Plan B');
	expect(todo.done()).toBe(true);
	expect(todo.notes()).toBe('Notes\n');
	expect(todo.isSaving).toBe(true);
	await eventually(() => fake.heldReplies() === 1);
	expect(fake.writes).toHaveLength(1);

	fake.releaseReplies();
	expect(await written(todo)).toBeUndefined();
	// The first write, then the latest input; the one between was superseded.
	expect(fake.writes).toHaveLength(2);
	expect(saved.count).toBe(1);
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

test("a title change keeps the body byte for byte, and textareas show LF while saves keep the file's CRLF", async () => {
	const body = 'Line one\r\nLine two\r\n';
	const { fake, todo } = await setup(row('Plan', body));
	expect(todo.notes()).toBe('Line one\nLine two\n');

	todo.setTitle('Plan B');
	expect(await written(todo)).toBeUndefined();
	expect(parsed(fake.disk()).body).toBe(body);

	todo.setNotes('Line one\nLine two\nLine three\n');
	expect(await written(todo)).toBeUndefined();
	expect(parsed(fake.disk()).body).toBe(
		'Line one\r\nLine two\r\nLine three\r\n',
	);

	// The source view shows LF and writes the file's convention back.
	expect(todo.editSource()).toBeUndefined();
	const shown = todo.text();
	expect(shown).not.toContain('\r');
	todo.setText(shown.replace('Line three', 'Line 3'));
	expect(await written(todo)).toBeUndefined();
	expect(fake.disk()).toBe(
		shown.replace('Line three', 'Line 3').replace(/\n/g, '\r\n'),
	);
});

test('raw and fields edits share one native editor: unknown metadata stays, and an omitted key is deleted', async () => {
	const { fake, todo } = await setup(row('Plan', 'Body.\n', UNKNOWN));
	const { editor } = todo;

	expect(todo.editSource()).toBeUndefined();
	expect(todo.rawMode).toBe(true);
	todo.setText(
		todo.text().replace('"owner": "sam"\n', '').replace('"Plan"', '"Plan B"'),
	);
	expect(await written(todo)).toBeUndefined();
	expect(parsed(fake.disk()).fields).toEqual({
		title: 'Plan B',
		done: false,
		unknown: { nested: ['one', 'two'] },
	});

	expect(todo.editFields()).toBeUndefined();
	expect(todo.rawMode).toBe(false);
	todo.setTitle('Plan C');
	expect(await written(todo)).toBeUndefined();
	expect(parsed(fake.disk())).toEqual({
		fields: {
			title: 'Plan C',
			done: false,
			unknown: { nested: ['one', 'two'] },
		},
		body: 'Body.\n',
	});
	// Switching modes never replaced the owner.
	expect(todo.editor).toBe(editor);
});

test('a malformed row opens for raw repair; raw mode stays after the repair until the person chooses fields', async () => {
	const { fake, todo } = await setup('---\ntitle: *missing\n---\n');
	expect(todo.editor.row.status).toBe('invalid');
	expect(todo.diagnostics()?.summary).toContain('cannot be edited as fields');
	expect(todo.editFields()).toContain('does not read as a todo');

	// No fields view exists for an invalid row, so its setters admit nothing.
	todo.setTitle('Typed');
	todo.setDone(true);
	expect(todo.text()).toBe('---\ntitle: *missing\n---\n');

	todo.setText('---\ntitle: Fixed\ndone: false\n---\n');
	expect(todo.rawMode).toBe(true);
	expect(await written(todo)).toBeUndefined();
	expect(fake.disk()).toBe('---\ntitle: Fixed\ndone: false\n---\n');
	expect(todo.editor.row.status).toBe('valid');
	expect(todo.rawMode).toBe(true);

	expect(todo.editFields()).toBeUndefined();
	expect(todo.title()).toBe('Fixed');
});

test("under the fixture's stricter schema, where a title needs a character (the Todos schema allows an empty one), schema-invalid fields input is saved and the row moves to raw repair with no partial form", async () => {
	const { fake, todo } = await setup();
	// This fixture table's title needs at least one character; Todos' does not.
	todo.setTitle('');
	expect(await written(todo)).toBeUndefined();
	expect(parsed(fake.disk()).fields.title).toBe('');
	expect(todo.editor.row.status).toBe('invalid');
	expect(todo.title()).toBe('');
	expect(todo.diagnostics()?.details.length).toBeGreaterThan(0);
	// The raw view takes the repair; the fields setters stay closed.
	const before = todo.text();
	todo.setTitle('ignored');
	expect(todo.text()).toBe(before);
	todo.setText(before.replace('"title": ""', '"title": "Back"'));
	expect(await written(todo)).toBeUndefined();
	expect(parsed(fake.disk()).fields.title).toBe('Back');
});

test('a leaving view admits nothing: raw input outside raw mode, and fields input in raw mode', async () => {
	const { fake, todo } = await setup();
	const before = todo.editor.row.text;

	todo.setText('junk');
	expect(todo.editor.row.text).toBe(before);

	expect(todo.editSource()).toBeUndefined();
	expect(todo.setTitle('ignored')).toBeUndefined();
	todo.setNotes('ignored');
	todo.setDone(true);
	expect(todo.editor.row.text).toBe(before);
	expect(fake.writes).toEqual([]);
});

test('a failed save keeps newer input on screen and writes nothing until Try again, which writes the latest input', async () => {
	const { fake, todo } = await setup();
	fake.script('io');
	todo.setTitle('A');
	expect(await written(todo)).toBe('Io');
	expect(todo.hasProblem).toBe(true);
	expect(fake.writes).toEqual([]);

	todo.setTitle('B');
	expect(todo.title()).toBe('B');
	expect(await written(todo)).toBe('Io');
	expect(fake.writes).toEqual([]);
	expect(await todo.toggle(true)).toContain('did not finish');

	expect(todo.retry()).toBeUndefined();
	expect(await written(todo)).toBeUndefined();
	expect(todo.isIdle).toBe(true);
	expect(fake.writes.map((text) => parsed(text).fields.title)).toEqual(['B']);
});

test('Try again writes the exact text on screen: a comment and quoting stay', async () => {
	const commented =
		"---\n# kept by sam\ntitle: 'Plan'\ndone: false\n---\nBody.\n";
	const { fake, todo } = await setup(commented);
	expect(todo.editor.row.status).toBe('valid');
	expect(todo.editSource()).toBeUndefined();
	const typed = commented.replace("'Plan'", "'Plan B' # renamed");
	fake.script('io');
	todo.setText(typed);
	expect(await written(todo)).toBe('Io');
	expect(todo.editor.row).toMatchObject({ status: 'valid', text: typed });

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
	expect(todo.title()).toBe('Plan');
	todo.setNotes('mine\n');
	expect(await written(todo)).toBeUndefined();
	expect(parsed(fake.disk())).toMatchObject({
		fields: { title: 'Plan' },
		body: 'mine\n',
	});

	fake.writeElsewhere(row('Theirs again'));
	expect(await todo.editor.reload()).toMatchObject({ error: null });
	expect(todo.title()).toBe('Theirs again');
	expect(fake.disk()).toBe(row('Theirs again'));
});

test('Reload after a failed save adopts the file and ends the failure; a read that fails keeps the input', async () => {
	const { fake, todo } = await setup();
	fake.script('io');
	todo.setTitle('Mine');
	expect(await written(todo)).toBe('Io');

	fake.failReads(
		FileError.Io({ path: PATH, operation: 'read', cause: 'busy' }).error,
	);
	expect((await todo.editor.reload()).error?.name).toBe('Io');
	expect(todo.title()).toBe('Mine');
	expect(todo.hasProblem).toBe(true);

	fake.failReads(undefined);
	expect((await todo.editor.reload()).error).toBeNull();
	expect(todo.title()).toBe('Plan');
	expect(todo.isIdle).toBe(true);
	expect(fake.writes).toEqual([]);
});

test('a refused title or notes value stays in its field with why, other fields keep saving, and it counts as unsaved until a valid value or Reload', async () => {
	const { fake, todo } = await setup();
	expect(todo.setNotes('a\uD800b')).toContain('notes cannot be saved');
	// The typed value stays in the field; the row itself took nothing.
	expect(todo.notes()).toBe('a\uD800b');
	expect(todo.refusals).toEqual([expect.stringContaining('lone surrogate')]);
	expect(todo.editor.row.text).toBe(row('Plan'));
	expect(todo.isIdle).toBe(false);
	expect(todo.hasProblem).toBe(true);
	expect(fake.writes).toEqual([]);

	// Another field saves the accepted row; the refused notes stay on screen.
	todo.setTitle('Plan B');
	expect(await written(todo)).toBeUndefined();
	expect(parsed(fake.disk())).toEqual({
		fields: { title: 'Plan B', done: false },
		body: 'Body.\n',
	});
	expect(todo.notes()).toBe('a\uD800b');

	// Fences, settling, a departure, and the source view do not drop it.
	expect(await todo.settle()).toBe(false);
	expect(await todo.fence(async (settled) => settled)).toBe(false);
	todo.prepareDeparture();
	expect(await todo.drainDeparture()).toBe(false);
	todo.resumeDeparture();
	expect(todo.editSource()).toContain('cannot be saved');
	expect(todo.rawMode).toBe(false);
	expect(todo.notes()).toBe('a\uD800b');

	// A corrected value is accepted and clears the refusal.
	todo.setNotes('ab\n');
	expect(todo.refusals).toEqual([]);
	expect(await written(todo)).toBeUndefined();
	expect(parsed(fake.disk()).body).toBe('ab\n');
	expect(todo.isIdle).toBe(true);

	// A deliberate Reload drops a refused title and shows the row.
	expect(todo.setTitle('x\uD800')).toContain('title cannot be saved');
	expect(todo.title()).toBe('x\uD800');
	expect((await todo.reload()).error).toBeNull();
	expect(todo.title()).toBe('Plan B');
	expect(todo.refusals).toEqual([]);
	expect(todo.isIdle).toBe(true);
});

test('raw text UTF-8 cannot encode exactly is held by the native editor and fails on its turn without a write; a fix and Try again write it', async () => {
	const { fake, todo } = await setup();
	expect(todo.editSource()).toBeUndefined();
	const valid = todo.text();
	todo.setText(`${valid}\uD800`);
	expect(await written(todo)).toBe('Unencodable');
	expect(todo.editor.row).toMatchObject({
		status: 'invalid',
		error: { name: 'Unencodable' },
	});
	expect(todo.diagnostics()?.summary).toContain('cannot be saved exactly');
	expect(fake.writes).toEqual([]);

	todo.setText(`${valid}fixed\n`);
	expect(await written(todo)).toBe('Unencodable');
	expect(todo.retry()).toBeUndefined();
	expect(await written(todo)).toBeUndefined();
	expect(fake.disk()).toBe(`${valid}fixed\n`);
});

test('a fence refuses input and waits for admitted writes; a failure leaves it unsettled', async () => {
	const { fake, todo } = await setup();
	fake.holdReplies();
	todo.setTitle('A');
	let ran = false;
	const fenced = todo.fence(async (settled) => {
		ran = true;
		return settled;
	});
	expect(todo.isFenced).toBe(true);
	todo.setTitle('ignored');
	expect(todo.title()).toBe('A');
	expect(todo.retry()).toBe(BUSY);
	await Bun.sleep(10);
	expect(ran).toBe(false);
	fake.releaseReplies();
	expect(await fenced).toBe(true);
	expect(todo.isFenced).toBe(false);
	expect(parsed(fake.disk()).fields.title).toBe('A');

	fake.script('io');
	todo.setTitle('B');
	expect(await todo.fence(async (settled) => settled)).toBe(false);
	expect(todo.hasProblem).toBe(true);
	// Newer input after the failure is not written by the fence either.
	todo.setTitle('C');
	expect(await todo.fence(async (settled) => settled)).toBe(false);
	expect(parsed(fake.disk()).fields.title).toBe('A');
});

test('a hold refuses input while its work runs, then reads the row the work wrote', async () => {
	const { fake, todo } = await setup();
	await todo.hold(async () => {
		expect(todo.isFenced).toBe(true);
		todo.setTitle('Typed during');
		expect(todo.title()).toBe('Plan');
		fake.writeElsewhere(row('Incoming'));
	});
	expect(todo.isFenced).toBe(false);
	expect(todo.title()).toBe('Incoming');
	expect(todo.isIdle).toBe(true);
	expect(fake.writes).toEqual([]);
});

test('release ends the subscription, and an admitted write still publishes', async () => {
	const { fake, todo } = await setup();
	expect(fake.subscriptions()).toBe(1);
	fake.holdReplies();
	todo.setTitle('A');
	todo.release();
	expect(fake.subscriptions()).toBe(0);
	todo.setTitle('B');
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
	todo.setTitle('Late');
	todo.setNotes('late\n');
	todo.setDone(true);
	expect(todo.retry()).toBe(RELEASED);
	expect(await todo.toggle(true)).toBe(RELEASED);
	expect(todo.editSource()).toBe(RELEASED);
	expect(fake.writes).toEqual([]);
	expect(todo.isIdle).toBe(true);
});

test('close refuses input, waits for the write, and ends the subscription', async () => {
	const { fake, todo } = await setup();
	fake.holdReplies();
	todo.setTitle('Last');
	const closing = todo.close();
	todo.setTitle('ignored');
	await Bun.sleep(10);
	fake.releaseReplies();
	expect(await closing).toBe(true);
	expect(parsed(fake.disk()).fields.title).toBe('Last');
	expect(fake.subscriptions()).toBe(0);
});

test('reload fences field controls while discarding refused input', async () => {
	const { fake, todo } = await setup();
	fake.holdReplies();
	todo.setTitle('Saved title');
	await eventually(() => fake.heldReplies() > 0);
	todo.setNotes('bad\uD800');
	const reloading = todo.reload();
	expect(todo.isFenced).toBe(true);
	todo.setTitle('late\uD800');
	expect(todo.title()).toBe('Saved title');
	fake.releaseReplies();
	expect((await reloading).error).toBeNull();
	expect(todo.isFenced).toBe(false);
	expect(todo.refusals).toEqual([]);
});
