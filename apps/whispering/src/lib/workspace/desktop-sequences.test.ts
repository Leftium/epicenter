/**
 * Save and delete sequences over the production desktop adapter.
 *
 * The real library and the folder's real row editor run over
 * `@epicenter/folder/tauri`, with the shell's owner scripted in memory
 * (`scripted-owner.test-support.ts`). That is where a reply can be lost after
 * its change landed, or a change held while the person types.
 *
 * Key behaviors:
 * - a save whose reply was lost holds the draft even after a read finds its
 *   text: the close asks, its source is not taken over, and nothing is
 *   written until the person takes the file as it is or saves again
 * - a deletion is refused while a save of the row is out, and the save lands
 * - a row being deleted takes no typing and is not written again; a deletion
 *   whose reply was lost puts the draft down and recreates nothing
 *
 * See also:
 * - `desktop.test.ts` for the workspace over scripted shell replies
 */
import '../svelte-modules.test-support.js';
import { afterEach, expect, mock, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import { whisperingDefinition } from '../definition.js';
import type { Library } from '../library.svelte.js';
import type { RowDraft } from '../row-draft.svelte.js';
import { formOf, textOf } from '../row-slot.test-support.js';
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
const { TYPING_BATCH_MS } = await import('../editor.svelte.ts');

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const PATH = 'transformations/clean.md';
const SEED = '---\ntitle: Clean up\nmodel: null\nendpoint: null\n---\nTidy.\n';
const pause = () => Bun.sleep(TYPING_BATCH_MS + 150);

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
	if (path !== PATH) {
		const selection = library.selection;
		if (selection?.kind !== 'transcript')
			throw new Error(`Expected ${path} open as a transcript`);
		return { library, draft: formOf(selection.slot) };
	}
	return { library, draft: formOf(library.selectedTransformation?.slot) };
}

test('a save whose reply was lost holds the draft after a read finds its text, until the person chooses', async () => {
	const { library, draft } = await open({ [PATH]: SEED });
	owner.control.loseReplies = 1;

	draft.change({ body: 'Tidy it.\n' });
	expect(await draft.settle()).toBe(false);
	await library.refreshAll();

	// The owner wrote it; the draft is clean against what it read; the save is unknown.
	expect(owner.text(PATH)).toContain('Tidy it.');
	expect(draft.isDirty).toBe(false);
	expect(draft.status).toMatchObject({ kind: 'unconfirmed', inFile: true });
	expect(draft.holds).toBe(true);
	expect(await draft.settle()).toBe(false);
	expect(library.holdsUnsavedWork).toBe(true);
	expect(library.unsavedWork).toEqual([
		`${PATH} has edits whose last save was not confirmed.`,
	]);
	expect(await library.prepareToLeave()).toBe(false);
	// Its source is not taken over, which would put the unknown save down.
	expect(await library.editSource(PATH)).toContain('Save or discard');
	expect(library.selectedTransformation?.slot.kind).toBe('form');

	// Typing after it waits for the person.
	draft.change({ body: 'Tidy it more.\n' });
	await pause();
	expect(await library.prepareToLeave()).toBe(false);
	expect(owner.applied).toHaveLength(1);

	// Taking the file as it is releases the draft; the save stays unknown.
	expect(await library.discardDraft(PATH)).toBeUndefined();
	expect(draft.holds).toBe(false);
	expect(draft.state.document.body).toBe('Tidy it.\n');
	expect(draft.state.lastSave?.kind).toBe('unconfirmed');
	expect(draft.unknown).toBeDefined();
	expect(await library.prepareToLeave()).toBe(true);

	// Now its source can be taken over, and typing there saves on its own.
	expect(await library.editSource(PATH)).toBeUndefined();
	const text = textOf(library.selectedTransformation?.slot);
	text.input(`${text.buffer}Typed as text.\n`);
	await pause();
	expect(owner.applied).toHaveLength(2);
	expect(owner.text(PATH)).toContain('Typed as text.');
});

test('saving again after a lost reply is the person’s choice, and its own reply releases the draft', async () => {
	const { library, draft } = await open({ [PATH]: SEED });
	owner.control.loseReplies = 1;
	draft.change({ body: 'Tidy it.\n' });
	await draft.settle();
	await library.refreshAll();

	await draft.saveNow();

	expect(owner.applied).toHaveLength(2);
	expect(draft.status).toEqual({ kind: 'saved' });
	expect(draft.holds).toBe(false);
	expect(draft.unknown).toBeUndefined();
	expect(await library.prepareToLeave()).toBe(true);
});

test('a deletion is refused while a save of the row is out, and the save lands', async () => {
	const { library, draft } = await open({ [PATH]: SEED });
	const deletion = expectOk(await library.deletionFor(PATH));
	const reached = deferred<void>();
	const held = deferred<void>();
	owner.control.beforeApply = async (change) => {
		if (change.kind !== 'overwrite') return;
		reached.resolve();
		await held.promise;
	};

	draft.change({ body: 'Saved while it was being deleted.\n' });
	const saving = draft.saveNow();
	await reached.promise;
	expect(await library.remove(deletion)).toContain('Save or discard');
	held.resolve();
	await saving;

	expect(draft.status).toEqual({ kind: 'saved' });
	expect(owner.text(PATH)).toContain('Saved while it was being deleted.');
	expect(owner.applied.map((change) => change.kind)).toEqual(['overwrite']);
});

test('a row being deleted takes no typing, and a late save cannot recreate it', async () => {
	const { library, draft } = await open({ [PATH]: SEED });
	const deletion = expectOk(await library.deletionFor(PATH));
	const reached = deferred<void>();
	const held = deferred<void>();
	owner.control.beforeApply = async (change) => {
		if (change.kind !== 'remove') return;
		reached.resolve();
		await held.promise;
	};

	const removing = library.remove(deletion);
	await reached.promise;
	expect(draft.change({ body: 'Typed while it was deleted.\n' })).toBe(false);
	await draft.saveNow();
	held.resolve();
	expect(await removing).toBeUndefined();
	await pause();

	expect(owner.text(PATH)).toBeUndefined();
	expect(owner.applied.map((change) => change.kind)).toEqual(['remove']);
	expect(draft.state.isDisposed).toBe(true);
});

test('a deletion whose reply was lost puts the draft down, recreates nothing, and the file is shown as it is when opened again', async () => {
	const { library, draft } = await open({ [PATH]: SEED });
	const deletion = expectOk(await library.deletionFor(PATH));
	owner.control.loseReplies = 1;

	const problem = await library.remove(deletion);

	expect(problem).toContain('did not confirm the deletion');
	expect(draft.state.isDisposed).toBe(true);
	expect(library.selectedTransformation).toBeUndefined();
	expect(library.holdsUnsavedWork).toBe(false);
	await pause();
	expect(owner.text(PATH)).toBeUndefined();
	expect(owner.applied.map((change) => change.kind)).toEqual(['remove']);

	// Opening it again reads the folder: the file is gone.
	await library.open(PATH);
	expect(library.selectedTransformation).toBeUndefined();
	expect(library.transformations).toEqual([]);
});

// ============================================================================
// A rename that did not end as asked
// ============================================================================

const ONE = 'transcriptions/one.md';
const TWO = 'transcriptions/two.md';
const TRANSCRIPT =
	'---\nrecordingId: one\ncreatedAt: 2026-10-01T00:00:00.000Z\nmodel: m\nendpoint: http://127.0.0.1:18080/v1\n---\nThe words.\n';
const TYPED = 'Typed while it moved.\n';

/**
 * Rename one.md to two.md with the owner's move held, type into the draft
 * while it waits, then let `settle` decide what the owner does and answers.
 */
async function renameWithTyping(settle: () => void) {
	const opened = await open({ [ONE]: TRANSCRIPT }, ONE);
	const reached = deferred<void>();
	const held = deferred<void>();
	owner.control.beforeApply = async (change) => {
		if (change.kind !== 'move') return;
		reached.resolve();
		await held.promise;
		settle();
	};
	const renaming = opened.library.rename(ONE, 'two.md');
	await reached.promise;
	expect(opened.draft.change({ body: TYPED })).toBe(true);
	held.resolve();
	const said = await renaming;
	return { ...opened, said };
}

/** Nothing writes on its own while the rename waits for the person. */
async function expectHeld(library: Library, draft: RowDraft<unknown>) {
	const before = owner.applied.length;
	await pause();
	await library.refreshAll();
	await pause();
	expect(owner.applied).toHaveLength(before);
	expect(draft.state.lastSave).toBeUndefined();
	expect(draft.state.document.body).toBe(TYPED);
	expect(library.holdsUnsavedWork).toBe(true);
	expect(library.unsavedWork[0]).toContain('did not end as asked');
	expect(await library.prepareToLeave()).toBe(false);
	expect(await draft.settle()).toBe(false);
	expect(await library.editSource(ONE)).toContain('Save or discard');
	expect(await library.rename(ONE, 'three.md')).toContain('did not end as asked');
	expect(await library.deletionFor(ONE)).toMatchObject({
		error: expect.stringContaining('did not end as asked'),
	});
	expect(owner.applied).toHaveLength(before);
}

test('a move that landed with its reply lost holds the typing; a matching destination is not taken until the person keeps the edits there', async () => {
	const { library, draft, said } = await renameWithTyping(() => {
		owner.control.loseReplies = 1;
	});

	expect(said).toContain('did not confirm the rename');
	expect(owner.text(ONE)).toBeUndefined();
	expect(owner.text(TWO)).toBe(TRANSCRIPT);
	expect(library.unresolvedMoves).toEqual([
		expect.objectContaining({
			from: ONE,
			to: TWO,
			found: { from: 'missing', to: 'matches' },
		}),
	]);
	// The view stays on the draft; nothing says the move happened.
	expect(library.selectedPath).toBe(ONE);
	await expectHeld(library, draft);
	expect(owner.applied.map((change) => change.kind)).toEqual(['move']);

	// The source holds nothing, so the edits cannot be kept there.
	expect(await library.resolveMove(ONE, 'keepAtSource')).toContain(
		'does not hold the file as it was',
	);
	expect(await library.resolveMove(ONE, 'keepAtDestination')).toBeUndefined();

	const moved = formOf(library.transcriptAt(TWO));
	expect(moved.state.document.body).toBe(TYPED);
	expect(await moved.settle()).toBe(true);
	expect(owner.text(TWO)).toContain(TYPED);
	expect(owner.text(ONE)).toBeUndefined();
	expect(owner.applied.map((change) => change.kind)).toEqual([
		'move',
		'overwrite',
	]);
	expect(draft.state.isDisposed).toBe(true);
	expect(library.unresolvedMoves).toEqual([]);
	expect(library.selectedPath).toBe(TWO);
	expect(library.holdsUnsavedWork).toBe(false);
});

test('a move whose reply was lost before it happened holds the typing until the person keeps it at the source', async () => {
	const { library, draft, said } = await renameWithTyping(() => {
		throw 'the reply never reached the window';
	});

	expect(said).toContain('did not confirm the rename');
	expect(owner.text(ONE)).toBe(TRANSCRIPT);
	expect(owner.text(TWO)).toBeUndefined();
	expect(library.unresolvedMoves[0]?.found).toEqual({
		from: 'matches',
		to: 'missing',
	});
	await expectHeld(library, draft);
	expect(owner.applied).toEqual([]);

	expect(await library.resolveMove(ONE, 'keepAtDestination')).toContain(
		'does not hold the file as it was',
	);
	expect(await library.resolveMove(ONE, 'keepAtSource')).toBeUndefined();
	expect(await draft.settle()).toBe(true);
	expect(owner.text(ONE)).toContain(TYPED);
	expect(owner.text(TWO)).toBeUndefined();
	expect(owner.applied.map((change) => change.kind)).toEqual(['overwrite']);
	expect(library.unresolvedMoves).toEqual([]);
	expect(library.holdsUnsavedWork).toBe(false);
});

test('when neither path holds the file as it was, the typing is held, neither path is written, and the edits can be saved as a copy', async () => {
	const { library, draft, said } = await renameWithTyping(() => {
		// Another program removed the source and wrote its own file at the destination.
		owner.disk.delete(ONE);
		owner.write(TWO, 'Someone else\n');
		throw 'the reply never reached the window';
	});

	expect(said).toContain('did not confirm the rename');
	expect(library.unresolvedMoves[0]?.found).toEqual({
		from: 'missing',
		to: 'different',
	});
	await expectHeld(library, draft);
	expect(owner.applied).toEqual([]);
	for (const choice of ['keepAtSource', 'keepAtDestination'] as const)
		expect(await library.resolveMove(ONE, choice)).toContain(
			'does not hold the file as it was',
		);
	expect(library.heldText(ONE)).toContain(TYPED);

	const copy = expectOk(await library.copyHeldEdits(ONE));

	expect(copy).toMatch(/^conflicts\/one-\d{8}-\d{6}\.md$/);
	expect(owner.text(copy)).toContain(TYPED);
	expect(owner.text(TWO)).toBe('Someone else\n');
	expect(owner.text(ONE)).toBeUndefined();
	expect(owner.applied.map((change) => change.kind)).toEqual(['create']);
	expect(draft.state.isDisposed).toBe(true);
	expect(library.unresolvedMoves).toEqual([]);
	expect(library.holdsUnsavedWork).toBe(false);
});

test('discarding an unresolved rename’s edits writes nothing and opens nothing in their place', async () => {
	const { library, draft } = await renameWithTyping(() => {
		owner.control.loseReplies = 1;
	});

	expect(await library.resolveMove(ONE, 'discard')).toBeUndefined();

	await pause();
	expect(owner.applied.map((change) => change.kind)).toEqual(['move']);
	expect(owner.text(TWO)).toBe(TRANSCRIPT);
	expect(draft.state.isDisposed).toBe(true);
	expect(library.unresolvedMoves).toEqual([]);
	expect(library.selectedPath).toBeUndefined();
	expect(library.holdsUnsavedWork).toBe(false);
});

// ============================================================================
// A held draft whose file is changed or removed from outside
// ============================================================================

const INVALID =
	'---\ntitle: [1, 2]\nmodel: null\nendpoint: null\n---\nSomeone else.\n';

/** A transformation whose save landed with its reply lost, then read back clean. */
async function heldAfterLostReply() {
	const opened = await open({ [PATH]: SEED });
	owner.control.loseReplies = 1;
	opened.draft.change({ body: 'Tidy it.\n' });
	await opened.draft.settle();
	await opened.library.refreshAll();
	expect(opened.draft.status).toMatchObject({
		kind: 'unconfirmed',
		inFile: true,
	});
	expect(opened.draft.holds).toBe(true);
	return opened;
}

test('a held draft whose file another writer made invalid keeps its draft and shows that file as its review, until the person takes it', async () => {
	const { library, draft } = await heldAfterLostReply();

	owner.write(PATH, INVALID);
	await library.refreshAll();
	await pause();

	// Not reopened as text on its own: the same draft, with the read as its review.
	expect(formOf(library.selectedTransformation?.slot)).toBe(draft);
	expect(draft.state.isDisposed).toBe(false);
	expect(draft.status).toMatchObject({ kind: 'unrecognized', source: INVALID });
	expect(draft.state.lastSave?.kind).toBe('unconfirmed');
	expect(draft.unknown).toBeDefined();
	expect(draft.holds).toBe(true);
	expect(library.holdsUnsavedWork).toBe(true);
	expect(await library.prepareToLeave()).toBe(false);
	expect(owner.applied).toHaveLength(1);
	expect(owner.text(PATH)).toBe(INVALID);

	// Taking the file as it is opens it as its text, and writes nothing.
	expect(await library.discardDraft(PATH)).toBeUndefined();
	const text = textOf(library.selectedTransformation?.slot);
	expect(text.buffer).toBe(INVALID);
	await pause();
	expect(owner.applied).toHaveLength(1);
	expect(library.holdsUnsavedWork).toBe(false);
});

test('a held draft whose file another writer removed is not put down or written again on its own', async () => {
	const { library, draft } = await heldAfterLostReply();

	owner.disk.delete(PATH);
	await library.refreshAll();
	await pause();

	expect(formOf(library.selectedTransformation?.slot)).toBe(draft);
	expect(draft.status.kind).toBe('removed');
	expect(draft.unknown).toBeDefined();
	expect(draft.holds).toBe(true);
	expect(library.holdsUnsavedWork).toBe(true);
	expect(owner.text(PATH)).toBeUndefined();
	expect(owner.applied).toHaveLength(1);

	// Closing the draft is the person's choice; nothing is recreated.
	expect(await library.discardDraft(PATH)).toBeUndefined();
	expect(library.selectedTransformation).toBeUndefined();
	await pause();
	expect(owner.text(PATH)).toBeUndefined();
	expect(owner.applied).toHaveLength(1);
	expect(library.holdsUnsavedWork).toBe(false);
});
