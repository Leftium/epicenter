/**
 * Save, repair, and delete sequences over the production desktop adapter.
 *
 * The real library and the folder's real row editor run over
 * `@epicenter/folder/tauri`, with the shell's owner scripted in memory
 * (`scripted-owner.test-support.ts`). That is where a write can be held while
 * the person types, refused before it lands, or have its reply lost after it
 * landed, and where a read can fail.
 *
 * Key behaviors:
 * - typing is saved as it is typed: one write at a time, and the latest
 *   input behind it, so input superseded while a write runs is never written
 * - a save that failed, or whose reply was lost, stays on screen, holds the
 *   close while unresolved; later input saves again, and Save again
 *   resubmits the current input exactly
 * - another writer's change is not loaded into an open editor: the next save
 *   writes over it, and reloading, as the person asks, takes it and clears a
 *   stopped save; a reload whose read fails changes nothing
 * - a removed file is never created again; an editor holding nothing whose
 *   file is gone is put down
 * - a value with no form a file can hold is refused and not taken; source
 *   text a file cannot hold exactly is kept and never written lossily
 * - a deletion is refused while a save of the row is out, a row being
 *   deleted takes no input, and a deletion whose reply was lost recreates
 *   nothing
 * - a row's editor takes no input while its file moves, follows a confirmed
 *   rename, and is put down after one that did not end as asked
 *
 * See also:
 * - `desktop.test.ts` for the workspace over scripted shell replies
 * - `row-editing.test.ts` for the editor's own policy over a real directory
 */
import '../svelte-modules.test-support.js';
import { afterEach, expect, mock, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import { whisperingDefinition } from '../definition.js';
import type { Library } from '../library.svelte.js';
import { editingOf, untyped } from '../row-slot.test-support.js';
import { deferred, openTestWorkspace } from '../workspace.test-support.js';
import { createScriptedOwner } from './scripted-owner.test-support.js';
import { WHISPERING_FOLDER_ID, type Workspace } from './types.js';

let owner = createScriptedOwner();
mock.module('@tauri-apps/api/core', () => ({
	isTauri: () => true,
	invoke: (cmd: string, args?: Record<string, unknown>) =>
		owner.invoke(cmd, args),
}));
mock.module('@tauri-apps/api/event', () => ({
	listen: () => owner.listen(),
}));

const { openFolder } = await import('@epicenter/folder/tauri');
const { createLibrary } = await import('../library.svelte.ts');

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const PATH = 'transformations/clean.md';
const SEED = '---\ntitle: Clean up\nmodel: null\nendpoint: null\n---\nTidy.\n';

/** The library over the desktop adapter, with the owner holding `files`. */
async function open(files: Record<string, string>, path = PATH) {
	owner = createScriptedOwner();
	for (const [path, text] of Object.entries(files)) owner.write(path, text);
	const stubs = await openTestWorkspace();
	const folder = expectOk(
		await openFolder({
			id: WHISPERING_FOLDER_ID,
			definition: whisperingDefinition,
		}),
	);
	const workspace: Workspace = {
		...stubs.workspace,
		folder,
		close: () => folder.close(),
	};
	const library = createLibrary(workspace);
	cleanups.push(async () => {
		await library.close();
		await stubs.workspace.close();
		await stubs.remove();
	});
	await library.start();
	await library.open(path);
	if (path === PATH) return { library, editor: current(library) };
	const selection = library.selection;
	if (selection?.kind !== 'transcript')
		throw new Error(`Expected ${path} open as a transcript`);
	return { library, editor: untyped(editingOf(selection.slot)) };
}

/** The editor the library keeps for the transformation now. */
const current = (library: Library) =>
	untyped(editingOf(library.selectedTransformation?.slot));

const kinds = () => owner.applied.map((change) => change.kind);

/** The text of the `index`th change the owner applied. */
function written(index: number): string | undefined {
	const change = owner.applied[index];
	return change !== undefined && 'bytes' in change
		? new TextDecoder().decode(Uint8Array.from(change.bytes))
		: undefined;
}

/** Hold the owner's next change of `kind` until `release`; `reached` when it arrives. */
function holdNextApply(kind: string) {
	const reached = deferred<void>();
	const held = deferred<void>();
	owner.control.beforeApply = async (change) => {
		if (change.kind !== kind) return;
		owner.control.beforeApply = undefined;
		reached.resolve();
		await held.promise;
	};
	return { reached: reached.promise, release: () => held.resolve() };
}

test('a save whose reply was lost stays unknown with its own message and later typing saves again', async () => {
	const { library, editor } = await open({ [PATH]: SEED });
	owner.control.loseReplies = 1;

	editor.setBody('Tidy it.\n');
	expect((await editor.waitForSaves()).error?.name).toBe('Unconfirmed');
	await library.refreshAll();

	// The owner wrote it, and a listing finding it there confirms nothing.
	expect(owner.text(PATH)).toContain('Tidy it.');
	expect(editor.status).toMatchObject({
		kind: 'unconfirmed',
		message: expect.stringContaining('the reply never reached the window'),
	});
	expect(editor.holds).toBe(true);
	expect(library.unsavedWork).toEqual([
		`${PATH} has edits whose last save was not confirmed.`,
	]);
	expect(await library.prepareToLeave()).toBe(false);

	// The source is a view of the same editor: it shows the latest input.
	expect(library.editSource(PATH)).toBeUndefined();
	expect(current(library)).toBe(editor);
	expect(editor.sourceValue()).toBe(owner.text(PATH)!);

	// Later typing starts another save, whose own reply confirms it.
	editor.setText(`${editor.sourceValue()}More.\n`);
	expect(editor.row.text).toContain('Tidy it.\nMore.\n');

	expectOk(await editor.waitForSaves());
	expect(owner.applied).toHaveLength(2);
	expect(owner.text(PATH)).toContain('Tidy it.\nMore.\n');
	expect(editor.status).toEqual({ kind: 'saved' });
	expect(editor.holds).toBe(false);
	expect(await library.prepareToLeave()).toBe(true);
});

test('saving again after a lost reply writes exactly the input it holds, its comments and quoting included', async () => {
	const handmade =
		"---\n# kept by hand\n'title': 'Clean up'\nmodel: null\nendpoint: null\n---\nTidy.\n";
	const { library, editor } = await open({ [PATH]: SEED });
	library.editSource(PATH);
	owner.control.loseReplies = 1;
	editor.setText(handmade);
	expect((await editor.waitForSaves()).error?.name).toBe('Unconfirmed');
	expect(editor.status.kind).toBe('unconfirmed');

	expect(editor.retry()).toBeUndefined();
	expectOk(await editor.waitForSaves());

	expect(owner.applied).toHaveLength(2);
	expect(owner.applied[1]).toEqual(owner.applied[0]);
	expect(owner.text(PATH)).toBe(handmade);
	expect(editor.row).toMatchObject({ status: 'valid', text: handmade });
	expect(editor.holds).toBe(false);
});

test('typing during a save is shown at once and saved after it; input superseded meanwhile is never written', async () => {
	const { editor } = await open({ [PATH]: SEED });
	const first = holdNextApply('replace');

	editor.setBody('First.\n');
	await first.reached;
	expect(editor.save.status).toBe('saving');
	editor.setBody('Second.\n');
	editor.setBody('Third.\n');
	// The latest is shown while the first is still being written.
	expect(editor.row).toMatchObject({ status: 'valid', body: 'Third.\n' });
	first.release();
	expectOk(await editor.waitForSaves());

	expect(kinds()).toEqual(['replace', 'replace']);
	expect(written(0)).toContain('First.\n');
	expect(written(1)).toContain('Third.\n');
	expect(owner.text(PATH)).toContain('Third.\n');
	expect(editor.holds).toBe(false);
});

test('a failed save keeps input and another writer’s change is not loaded; later typing writes the latest whole row over it', async () => {
	const { library, editor } = await open({ [PATH]: SEED });
	owner.control.refuseNext = 1;
	editor.setBody('A.\n');
	expect((await editor.waitForSaves()).error).not.toBeNull();
	expect(editor.status).toMatchObject({
		kind: 'failed',
		message: expect.stringContaining('the disk refused the write'),
	});

	const other = SEED.replace('Tidy.', 'C from another program.');
	owner.write(PATH, other);
	await library.refreshAll();

	// The failed input and its error stay visible; C is not loaded.
	expect(editor.row).toMatchObject({ status: 'valid', body: 'A.\n' });
	expect(editor.status.kind).toBe('failed');
	expect(owner.text(PATH)).toBe(other);
	expect(owner.applied).toEqual([]);
	expect(library.unsavedWork).toEqual([
		`${PATH} has edits whose last save failed.`,
	]);

	editor.setBody('B.\n');
	expectOk(await editor.waitForSaves());
	expect(owner.text(PATH)).toBe(editor.row.text);
	expect(owner.text(PATH)).toContain('B.\n');
	expect(library.holdsUnsavedWork).toBe(false);
});

test('discarding a failed save loads the file as it is now into the same editor, and writes nothing', async () => {
	const { library, editor } = await open({ [PATH]: SEED });
	owner.control.refuseNext = 1;
	editor.setBody('A.\n');
	await editor.waitForSaves();
	const other = SEED.replace('Tidy.', 'C.');
	owner.write(PATH, other);

	expect(await library.discardDraft(PATH)).toBeUndefined();

	expect(current(library)).toBe(editor);
	expect(editor.row).toMatchObject({ status: 'valid', text: other });
	expect(editor.status.kind).toBe('saved');
	expect(editor.holds).toBe(false);
	expect(owner.applied).toEqual([]);
	expect(await library.prepareToLeave()).toBe(true);
	// It takes typing and saves again as usual.
	editor.setBody('D.\n');
	expectOk(await editor.waitForSaves());
	expect(owner.text(PATH)).toContain('D.\n');
});

test('a discard whose read fails keeps the input on screen, the stopped save, and says why; once readable it loads the file', async () => {
	const { library, editor } = await open({ [PATH]: SEED });
	owner.control.refuseNext = 1;
	editor.setBody('A.\n');
	await editor.waitForSaves();
	owner.control.failReads.add(PATH);

	expect(await library.discardDraft(PATH)).toContain(
		'the disk could not be read',
	);
	expect(current(library)).toBe(editor);
	expect(editor.row).toMatchObject({ status: 'valid', body: 'A.\n' });
	expect(editor.status.kind).toBe('failed');
	expect(library.holdsUnsavedWork).toBe(true);
	// Still editable while unreadable; another refused save keeps newer input.
	owner.control.refuseNext = 1;
	editor.setBody('A, still mine.\n');
	expect(editor.row).toMatchObject({ body: 'A, still mine.\n' });
	expect((await editor.waitForSaves()).error).not.toBeNull();

	owner.control.failReads.delete(PATH);
	expect(await library.reloadRow(PATH)).toBeUndefined();
	expect(editor.row).toMatchObject({ status: 'valid', text: SEED });
	expect(editor.holds).toBe(false);
	expect(owner.applied).toEqual([]);
});

test('a row that cannot be read when it is opened stays shown with why, and trying again opens it', async () => {
	const OTHER = 'transformations/other.md';
	const { library } = await open({ [PATH]: SEED, [OTHER]: SEED });
	owner.control.failReads.add(OTHER);

	await library.open(OTHER);
	expect(library.selectedTransformation?.slot).toMatchObject({
		kind: 'unopened',
		message: expect.stringContaining('the disk could not be read'),
	});
	expect(await library.retryOpen(OTHER)).toContain(
		'the disk could not be read',
	);
	expect(library.holdsUnsavedWork).toBe(false);

	owner.control.failReads.delete(OTHER);
	expect(await library.retryOpen(OTHER)).toBeUndefined();
	expect(current(library).row).toMatchObject({ status: 'valid', text: SEED });
	expect(current(library).view).toBe('fields');
	expect(owner.applied).toEqual([]);
});

test('a write over a corrupt file is the person’s choice of what to save, and the fields come back', async () => {
	const { library, editor } = await open({ [PATH]: SEED });
	owner.write(PATH, Uint8Array.from([0xff, 0xfe, 0x00]));
	await library.refreshAll();
	// Not loaded: the editor still shows the text it has.
	expect(editor.row).toMatchObject({ status: 'valid', text: SEED });
	expect(await library.reloadRow(PATH)).toContain('could not be read');
	expect(owner.applied).toEqual([]);

	editor.setBody('Repaired.\n');
	expectOk(await editor.waitForSaves());

	expect(kinds()).toEqual(['replace']);
	expect(owner.text(PATH)).toContain('Repaired.\n');
	expect(editor.view).toBe('fields');
	expect(editor.holds).toBe(false);
});

test('a submission whose file was removed before it was written fails as gone, stays on screen, and is never written', async () => {
	const { library, editor } = await open({ [PATH]: SEED });
	owner.control.beforeApply = async (change) => {
		if (change.kind === 'replace') owner.disk.delete(PATH);
	};
	editor.setBody('Mine.\n');
	expect((await editor.waitForSaves()).error?.name).toBe('NotFound');
	owner.control.beforeApply = undefined;
	await library.refreshAll();

	expect(editor.status).toMatchObject({
		kind: 'removed',
		message: expect.stringContaining('never creates it again'),
	});
	expect(current(library)).toBe(editor);
	expect(editor.row).toMatchObject({ body: 'Mine.\n' });
	expect(library.holdsUnsavedWork).toBe(true);
	// Typing goes on and is kept; saving again creates nothing.
	editor.setBody('Mine, more.\n');
	expect(editor.retry()).toBeUndefined();
	expect((await editor.waitForSaves()).error?.name).toBe('NotFound');
	expect(owner.text(PATH)).toBeUndefined();
	expect(owner.applied).toEqual([]);

	// Discarding puts it down: there is no file to load.
	expect(await library.discardDraft(PATH)).toBeUndefined();
	expect(library.selectedTransformation).toBeUndefined();
	expect(library.holdsUnsavedWork).toBe(false);
	expect(owner.text(PATH)).toBeUndefined();
});

test('a saved editor whose file another writer removed is not a failed save, and is put down', async () => {
	const { library, editor } = await open({ [PATH]: SEED });
	editor.setBody('Saved.\n');
	expectOk(await editor.waitForSaves());
	owner.disk.delete(PATH);
	await library.refreshAll();

	expect(editor.released).toBe(true);
	expect(library.selectedTransformation).toBeUndefined();
	expect(library.saveProblems).toBe(0);
	expect(library.holdsUnsavedWork).toBe(false);
	expect(kinds()).toEqual(['replace']);
});

test('a typed value no file can hold is kept in its own field, holds the close, and is repaired there or discarded; nothing is written', async () => {
	const { library, editor } = await open({ [PATH]: SEED });
	const before = editor.row;
	const lone = 'Half a pair: \uD800.\n';

	editor.setBody(lone);

	// Not taken into the row, and still what the body's control shows.
	expect(editor.row).toBe(before);
	expect(editor.bodyText()).toBe(lone);
	expect(editor.fieldText('title')).toBe('Clean up');
	expect(editor.status).toMatchObject({ kind: 'refused', controls: ['body'] });
	expect(editor.holds).toBe(true);
	expect(library.saveProblems).toBe(1);
	expect(library.unsavedWork).toEqual([
		`${PATH} has a typed value that cannot be saved.`,
	]);
	expect(await library.prepareToLeave()).toBe(false);
	// Another field still takes input, and the kept body stays.
	editor.setField('title', 'Clean it');
	expectOk(await editor.waitForSaves());
	expect(editor.bodyText()).toBe(lone);
	expect(owner.text(PATH)).toContain('"title": "Clean it"');
	expect(owner.text(PATH)).toContain('Tidy.\n');

	// Repaired in the same field, it is taken and let go.
	editor.setBody('Whole.\n');
	expectOk(await editor.waitForSaves());
	expect(editor.status.kind).toBe('saved');
	expect(editor.holds).toBe(false);
	expect(owner.text(PATH)).toContain('Whole.\n');

	// Or the person discards it, and the field shows the row again.
	editor.setField('title', 'Half a pair: \uD800');
	expect(editor.fieldText('title')).toBe('Half a pair: \uD800');
	editor.dropRefused('title');
	expect(editor.fieldText('title')).toBe('Clean it');
	expect(editor.holds).toBe(false);
	expect(owner.text(PATH)).not.toContain('�');
});

test('source text a file cannot hold exactly is kept as typed and never written; corrected input saves again', async () => {
	const { library, editor } = await open({ [PATH]: SEED });
	library.editSource(PATH);
	const lone = `${SEED}Half a pair: \uD800.\n`;
	editor.setText(lone);

	expect((await editor.waitForSaves()).error?.name).toBe('Unencodable');
	expect(editor.row).toMatchObject({ status: 'invalid', text: lone });
	expect(editor.status.kind).toBe('failed');
	expect(owner.applied).toEqual([]);

	editor.setText(SEED.replace('Tidy.', 'Fixed.'));
	// The corrected input starts another save.
	expectOk(await editor.waitForSaves());
	expect(owner.text(PATH)).toContain('Fixed.');
});

test('a deletion is refused while a save of the row is out, and the save lands', async () => {
	const { library, editor } = await open({ [PATH]: SEED });
	const deletion = expectOk(await library.deletionFor(PATH));
	const save = holdNextApply('replace');

	editor.setBody('Saved while it was being deleted.\n');
	await save.reached;
	expect(await library.remove(deletion)).toContain('Save or discard');
	save.release();
	expectOk(await editor.waitForSaves());

	expect(editor.status).toEqual({ kind: 'saved' });
	expect(owner.text(PATH)).toContain('Saved while it was being deleted.');
	expect(kinds()).toEqual(['replace']);
});

test('a deletion acts on the file captured after settling, and refuses a file changed after the person was asked', async () => {
	const { library, editor } = await open({ [PATH]: SEED });
	editor.setBody('Settled first.\n');
	const deletion = expectOk(await library.deletionFor(PATH));
	expect(deletion).toMatchObject({
		kind: 'transformation',
		entry: { body: 'Settled first.\n' },
	});
	owner.write(PATH, SEED.replace('Tidy.', 'Changed after asking.'));

	expect(await library.remove(deletion)).toContain('different content');
	expect(owner.text(PATH)).toContain('Changed after asking.');
	expect(kinds()).toEqual(['replace']);
});

test('a row being deleted takes no input, and a late save cannot reach it', async () => {
	const { library, editor } = await open({ [PATH]: SEED });
	const deletion = expectOk(await library.deletionFor(PATH));
	const removal = holdNextApply('remove');

	const removing = library.remove(deletion);
	await removal.reached;
	const before = editor.row;
	editor.setBody('Typed while it was deleted.\n');
	expect(editor.row).toBe(before);
	expect(editor.save.status).toBe('idle');
	removal.release();
	expect(await removing).toBeUndefined();

	expect(owner.text(PATH)).toBeUndefined();
	expect(kinds()).toEqual(['remove']);
	expect(editor.released).toBe(true);
});

test('a deletion whose reply was lost puts the editor down, recreates nothing, and the file is shown as it is when opened again', async () => {
	const { library, editor } = await open({ [PATH]: SEED });
	const deletion = expectOk(await library.deletionFor(PATH));
	owner.control.loseReplies = 1;

	const problem = await library.remove(deletion);

	expect(problem).toContain('did not confirm the deletion');
	expect(editor.released).toBe(true);
	expect(library.selectedTransformation).toBeUndefined();
	expect(library.holdsUnsavedWork).toBe(false);
	expect(owner.text(PATH)).toBeUndefined();
	expect(kinds()).toEqual(['remove']);

	// Opening it again reads the folder: the file is gone.
	await library.open(PATH);
	expect(library.selectedTransformation).toBeUndefined();
	expect(library.transformations).toEqual([]);
});

// ============================================================================
// A rename, and one that did not end as asked
// ============================================================================

const ONE = 'transcriptions/one.md';
const TWO = 'transcriptions/two.md';
const TRANSCRIPT =
	'---\nrecordingId: one\ncreatedAt: 2026-10-01T00:00:00.000Z\nmodel: m\nendpoint: http://127.0.0.1:18080/v1\n---\nThe words.\n';

test('a rename settles the editor, captures the file after that, and the file opens at its new name', async () => {
	const { library, editor } = await open({ [ONE]: TRANSCRIPT }, ONE);
	editor.setBody('Typed before the rename.\n');

	expect(await library.rename(ONE, 'two.md')).toBeUndefined();

	expect(kinds()).toEqual(['replace', 'move']);
	expect(owner.text(TWO)).toContain('Typed before the rename.\n');
	expect(owner.text(ONE)).toBeUndefined();
	expect(editor.released).toBe(true);
	expect(library.selectedPath).toBe(TWO);
	expect(editingOf(library.transcriptAt(TWO)).row).toMatchObject({
		status: 'valid',
		body: 'Typed before the rename.\n',
	});
	expect(library.holdsUnsavedWork).toBe(false);
});

test('a move that landed with its reply lost takes no typing meanwhile, puts the editor down, and holds nothing', async () => {
	const { library, editor } = await open({ [ONE]: TRANSCRIPT }, ONE);
	const move = holdNextApply('move');
	owner.control.loseReplies = 1;

	const renaming = library.rename(ONE, 'two.md');
	await move.reached;
	editor.setBody('Typed while it moved.\n');
	expect(editor.row).toMatchObject({ body: 'The words.\n' });
	move.release();

	expect(await renaming).toContain('did not confirm the rename');
	expect(owner.text(ONE)).toBeUndefined();
	expect(owner.text(TWO)).toBe(TRANSCRIPT);
	expect(editor.released).toBe(true);
	expect(library.unresolvedMoves).toEqual([]);
	expect(library.holdsUnsavedWork).toBe(false);
	expect(kinds()).toEqual(['move']);

	// The person opens the path that holds it, as it is.
	await library.open(TWO);
	expect(editingOf(library.transcriptAt(TWO)).row.text).toBe(TRANSCRIPT);
	expect(kinds()).toEqual(['move']);
});

test('a move whose reply was lost before it happened leaves the file where it was, and opening it there edits it again', async () => {
	const { library, editor } = await open({ [ONE]: TRANSCRIPT }, ONE);
	owner.control.beforeApply = async (change) => {
		if (change.kind !== 'move') return;
		owner.control.beforeApply = undefined;
		throw 'the reply never reached the window';
	};

	expect(await library.rename(ONE, 'two.md')).toContain(
		'did not confirm the rename',
	);

	expect(owner.text(ONE)).toBe(TRANSCRIPT);
	expect(owner.text(TWO)).toBeUndefined();
	expect(editor.released).toBe(true);
	expect(library.holdsUnsavedWork).toBe(false);

	await library.open(ONE);
	const reopened = editingOf(library.transcriptAt(ONE));
	reopened.setBody('Typed after it was opened again.\n');
	expectOk(await reopened.waitForSaves());
	expect(owner.text(ONE)).toContain('Typed after it was opened again.\n');
	expect(owner.text(TWO)).toBeUndefined();
	expect(kinds()).toEqual(['replace']);
});
