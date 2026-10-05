/**
 * Word owner tests.
 * The real words list and each word's real row editor run over Vocab's real
 * browser folder on an in-memory OPFS stand-in. The stand-in holds, fails,
 * or loses the answer of a write where a test says, and changes or removes a
 * file the way another program would; the table's opening and delete answers
 * can be held too. Each race is played in a fixed order.
 *
 * Key behaviors:
 * - Every note keystroke and stage press goes to the word's one editor at
 *   once as the whole word, unknown metadata, body, and line endings included
 * - The editor reads the file once; a change made elsewhere is not read into
 *   it by the list, and the learner's next save replaces it
 * - A save that failed or whose answer was lost keeps the input shown and
 *   saves again on later input; reloading replaces the input with
 *   the file, and a reload that cannot read keeps both input and failure
 * - A note no file can hold is kept as typed with its reason and sends
 *   nothing; the word is not deleted, reloaded, or left without asking until
 *   that note is corrected or discarded
 * - No save creates a gone file; the word stays listed until it is let go
 * - A file that is not a valid word is repaired as exact text through the
 *   same editor
 * - Closing and deleting stop every view of the word first, then wait for
 *   the saves already admitted. A delete is fixed to what the learner was
 *   shown when they pressed it, and a refused delete sends no delete at all
 * - A delete whose answer was lost keeps the word until its file is read
 *   again or the word is let go
 *
 * See also:
 * - `entries.test.ts` for adding and listing
 * - `reread.test.ts` for listings made stale by this tab's saves
 * - `../routes/components/EntryCard.test.ts` for the mounted card
 */
import './svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import { FileError } from '@epicenter/folder';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	createBrowser,
	entriesOf,
	fileText,
	heldEntries,
	tableFiles,
	until,
} from './folder.test-support.js';

const { createEntriesState } = await import('./entries.svelte.js');

async function setup() {
	const browser = createBrowser();
	const folder = await browser.open();
	const { holds, table } = heldEntries(folder.tables.entries);
	const entries = createEntriesState({ table });
	expectOk(await entries.add('lucid'));
	const id = entries.entries[0]?.id ?? '';
	const path = `entries/${id}.md`;
	const { faults } = browser.opfs;
	return {
		browser,
		folder,
		holds,
		entries,
		id,
		path,
		file: () => fileText(folder, path),
		/** The word as a reload would list it. */
		async reopened() {
			const again = createEntriesState(entriesOf(await browser.open()));
			await again.refresh();
			return again.entries.map(({ text, note, stage }) => ({
				text,
				note,
				stage,
			}));
		},
		/** Hold the next write of this word's file until `release`. */
		holdWrite() {
			const started = Promise.withResolvers<void>();
			const gate = Promise.withResolvers<void>();
			faults.open = async (key) => {
				if (!key.endsWith(path)) return;
				faults.open = undefined;
				started.resolve();
				await gate.promise;
			};
			return { started: started.promise, release: () => gate.resolve() };
		},
		/** The next write of this word's file fails, or lands and loses its answer. */
		failWrite(how: 'fails' | 'lands unconfirmed') {
			if (how === 'fails')
				faults.write = (key) => {
					if (!key.endsWith(path)) return;
					faults.write = undefined;
					return 'fail';
				};
			else
				faults.close = (key) => {
					if (!key.endsWith(path)) return;
					faults.close = undefined;
					return 'lost';
				};
		},
		[Symbol.asyncDispose]: () => browser[Symbol.asyncDispose](),
	};
}

type Context = Awaited<ReturnType<typeof setup>>;

/** The word's file with a value that has no canonical form. */
async function tagged(context: Context) {
	return (
		(await context.file())?.replace(
			'\n---\n',
			'\nsource: !book Moby Dick\n---\n',
		) ?? ''
	);
}

/** Wait until the word's saves have stopped running. */
const idle = (word: ReturnType<Context['entries']['word']>) =>
	until(() => word.save?.status !== 'saving', 'the word to stop saving');

/** Words whose deletes land, or not, and lose their answer. */
async function unconfirmedDeletes(context: Context, landed: boolean) {
	const { folder, path } = context;
	const real = folder.tables.entries;
	const entries = createEntriesState({
		table: {
			...real,
			async delete(stem, options) {
				if (landed) {
					const removed = await real.delete(stem, options);
					if (removed.error !== null) return removed;
				}
				return FileError.Unconfirmed({
					path,
					operation: 'removing',
					cause: new Error('the answer was lost'),
				});
			},
		},
	});
	await entries.refresh();
	return entries;
}

const NOT_UTF8 = new Uint8Array([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe, 0x0a]);

// ============================================================================
// Opening and closing
// ============================================================================

test('opening twice joins one attempt; closing while it opens keeps no editor and saves nothing', async () => {
	await using context = await setup();
	const { entries, holds, id } = context;
	const opening = Promise.withResolvers<void>();
	holds.edit = opening.promise;
	const word = entries.word(id);
	const before = await context.file();

	void word.open();
	void word.open();
	expect(word.opening).toBe(true);
	// Nothing is taken before the editor opens.
	expect(word.inputNote('typed while opening')).toBeNull();
	expect(word.note()).toBe('');
	const closing = entries.close();
	opening.resolve();
	await closing;

	expect(word.row).toBeUndefined();
	expect(word.inputNote('after')).toContain('closing');
	expect(await word.setStage('usable')).toContain('closing');
	expect(await context.file()).toBe(before);
});

test('closing waits for a save already admitted and takes no input after it starts', async () => {
	await using context = await setup();
	const { entries, id } = context;
	const word = entries.word(id);
	await word.open();
	const held = context.holdWrite();

	word.inputNote('sent');
	await held.started;
	expect(word.save?.status).toBe('saving');
	let closed = false;
	const closing = entries.close().then(() => {
		closed = true;
	});
	expect(word.inputNote('typed while closing')).toContain('closing');
	await Bun.sleep(5);
	expect(closed).toBe(false);

	held.release();
	await closing;
	expect(await context.reopened()).toEqual([
		{ text: 'lucid', note: 'sent', stage: 'new' },
	]);
});

// ============================================================================
// Saving as the learner types
// ============================================================================

test('each note keystroke reaches the editor at once as the whole word, and the list follows once it lands', async () => {
	await using context = await setup();
	const { entries, id } = context;
	const word = entries.word(id);
	await word.open();

	for (const text of ['c', 'cl', 'clear'])
		expect(word.inputNote(text)).toBeNull();
	expect(word.note()).toBe('clear');
	expect(word.save?.status).toBe('saving');
	expect(word.unsettled).toBe(true);

	await until(
		() => word.save?.status === 'idle' && entries.entries[0]?.note === 'clear',
		'the note to land and be listed',
	);
	expect(word.unsettled).toBe(false);
	expect(await context.reopened()).toEqual([
		{ text: 'lucid', note: 'clear', stage: 'new' },
	]);
});

test('every view shares one editor: a stage press saves the typed note, the list follows, and later typing keeps the stage', async () => {
	await using context = await setup();
	const { entries, id } = context;
	const word = entries.word(id);
	await word.open();

	expect(entries.word(id)).toBe(word);
	const note = 'honest,\nand a second line: "quoted"';
	word.inputNote(note);
	expect(await entries.word(id).setStage('understood')).toBeNull();
	expect(word.note()).toBe(note);
	expect(word.stage()).toBe('understood');
	expect(word.unsettled).toBe(false);
	await until(
		() => entries.entries[0]?.file.text === word.row?.text,
		'the list to show the saved word',
	);
	expect(await context.reopened()).toEqual([
		{ text: 'lucid', note, stage: 'understood' },
	]);
	const source = await context.file();
	expect(source).toStartWith('---\n"text": "lucid"\n"note": ');
	expect(entries.entries[0]).toMatchObject({ note, stage: 'understood' });
	expect(entries.entries[0]?.file.text).toBe(source);
	word.inputNote('typed more');
	await idle(word);
	expect(await context.reopened()).toEqual([
		{ text: 'lucid', note: 'typed more', stage: 'understood' },
	]);
});

test('a stage pressed before the word opens opens it and saves', async () => {
	await using context = await setup();
	const { entries, id } = context;
	expect(entries.word(id).stageable).toBe(true);
	expect(await entries.word(id).setStage('usable')).toBeNull();
	expect(await context.reopened()).toEqual([
		{ text: 'lucid', note: '', stage: 'usable' },
	]);
});

test('note and stage saves carry the metadata Vocab does not declare and the body, exactly', async () => {
	await using context = await setup();
	const { browser, entries, id, path } = context;
	const original = (await context.file()) ?? '';
	const withMore = `${original.replace('\n---\n', '\n"source": "a book"\n---\n')}Body line one.\r\nBody line two.\r\n`;
	browser.put(path, withMore);
	const word = entries.word(id);
	await word.open();
	expect(word.row?.status).toBe('valid');

	word.inputNote('first line\nsecond line');
	expect(await word.setStage('understood')).toBeNull();
	const saved = (await context.file()) ?? '';
	expect(saved).toContain('"source": "a book"');
	expect(saved).toEndWith('---\nBody line one.\r\nBody line two.\r\n');
	expect(await context.reopened()).toEqual([
		{ text: 'lucid', note: 'first line\nsecond line', stage: 'understood' },
	]);
});

test('a change saved elsewhere is not read into an open word, and the learner’s next save replaces it', async () => {
	await using context = await setup();
	const { browser, entries, id, path } = context;
	const word = entries.word(id);
	await word.open();
	const theirs = (await context.file())?.replace('note: ""', 'note: "theirs"');
	expect(theirs).toContain('theirs');
	browser.put(path, theirs ?? '');

	// The list reads the other version; the open word keeps what it read.
	await entries.refresh();
	expect(entries.entries[0]?.note).toBe('theirs');
	expect(word.note()).toBe('');

	word.inputNote('mine');
	await idle(word);
	expect(word.save?.status).toBe('idle');
	expect(await context.reopened()).toEqual([
		{ text: 'lucid', note: 'mine', stage: 'new' },
	]);
});

// ============================================================================
// A save that failed or whose answer was lost
// ============================================================================

test('a failed save keeps the input shown and later note and stage edits save the latest', async () => {
	await using context = await setup();
	const { entries, id } = context;
	const word = entries.word(id);
	await word.open();
	context.failWrite('fails');

	word.inputNote('first');
	await idle(word);
	expect(word.save?.status).toBe('failed');
	expect(word.unsettled).toBe(true);
	expect(word.note()).toBe('first');

	// Later input saves again, and a stage change saves the complete word.
	word.inputNote('first and second');
	expect(await word.setStage('recognized')).toBeNull();
	await Bun.sleep(5);
	expect(word.note()).toBe('first and second');
	expect(word.stage()).toBe('recognized');
	await until(() => word.save?.status === 'idle', 'the later edits to land');
	expect(word.unsettled).toBe(false);
	expect(await context.reopened()).toEqual([
		{ text: 'lucid', note: 'first and second', stage: 'recognized' },
	]);
});

test('a lost answer is shown as unknown, and Try again sends the word again', async () => {
	await using context = await setup();
	const { entries, id } = context;
	const word = entries.word(id);
	await word.open();
	context.failWrite('lands unconfirmed');

	word.inputNote('maybe saved');
	await idle(word);
	const { save } = word;
	expect(save?.status === 'failed' && save.error.name).toBe('Unconfirmed');
	const sent = await context.file();
	expect(sent).toContain('maybe saved');

	word.retry();
	await until(() => word.save?.status === 'idle', 'the retry to land');
	expect(await context.file()).toBe(sent);
	expect(word.unsettled).toBe(false);
});

test('reloading after a failed save replaces the input with what the file holds and clears the failure', async () => {
	await using context = await setup();
	const { browser, entries, id, path } = context;
	const word = entries.word(id);
	await word.open();
	context.failWrite('fails');
	word.inputNote('A');
	await idle(word);
	word.inputNote('B');
	const theirs = (await context.file())?.replace('note: ""', 'note: "C"') ?? '';
	browser.put(path, theirs);

	expect(await word.reload()).toBeNull();
	expect(word.save?.status).toBe('idle');
	expect(word.note()).toBe('C');
	expect(word.unsettled).toBe(false);
	expect(await context.file()).toBe(theirs);
	expect(entries.entries[0]?.note).toBe('C');
});

test('a reload that cannot read the file keeps the input and the failure', async () => {
	await using context = await setup();
	const { browser, entries, id, path } = context;
	const word = entries.word(id);
	await word.open();
	context.failWrite('fails');
	word.inputNote('kept');
	await idle(word);
	browser.put(path, NOT_UTF8);

	expect(await word.reload()).toContain('could not be read');
	expect(word.note()).toBe('kept');
	expect(word.save?.status).toBe('failed');
	expect(word.missing).toBe(false);
});

test('a note no file can hold is kept as typed with its reason, sends nothing, and holds deleting and reloading until it is corrected or discarded', async () => {
	await using context = await setup();
	const { entries, holds, id } = context;
	const word = entries.word(id);
	await word.open();
	const before = await context.file();

	expect(word.inputNote('half a pair: \uD800')).toBeNull();
	expect(word.note()).toBe('half a pair: \uD800');
	expect(word.refusedNote?.reason).toBeTruthy();
	expect(word.save?.status).toBe('idle');
	// Leaving the page asks first, and the word is neither deleted nor reloaded.
	expect(word.unsettled).toBe(true);
	expect(entries.unsettled).toBe(1);
	expect(expectErr(await entries.remove(id)).name).toBe('NoteHeld');
	expect(holds.deletes).toBe(0);
	expect(await word.reload()).toContain('Correct it or discard it');
	expect(word.note()).toBe('half a pair: \uD800');
	expect(await context.file()).toBe(before);

	// A corrected note is taken and saved.
	expect(word.inputNote('half a pair: fixed')).toBeNull();
	expect(word.refusedNote).toBeUndefined();
	await idle(word);
	expect(await context.reopened()).toEqual([
		{ text: 'lucid', note: 'half a pair: fixed', stage: 'new' },
	]);

	// Discarding another refused note shows the saved one again.
	word.inputNote('\uDC00');
	expect(word.refusedNote).toBeDefined();
	word.discardRefusedNote();
	expect(word.note()).toBe('half a pair: fixed');
	expect(word.unsettled).toBe(false);
});

test('a save over a file removed elsewhere fails as gone, creates nothing, and stays listed until it is let go', async () => {
	await using context = await setup();
	const { browser, entries, id, path, folder } = context;
	const word = entries.word(id);
	await word.open();
	browser.drop(path);

	word.inputNote('typed after it went');
	await idle(word);
	expect(word.missing).toBe(true);
	expect(word.stageable).toBe(false);
	expect(word.note()).toBe('typed after it went');
	word.retry();
	await idle(word);
	expect(await word.reload()).toContain('gone');
	expect(await tableFiles(folder, 'entries')).toEqual([]);

	await entries.refresh();
	expect(entries.entries.map((entry) => entry.id)).toEqual([id]);
	await entries.letGo(id);
	expect(entries.entries).toEqual([]);
	expect(entries.unsettled).toBe(0);
	expect(await tableFiles(folder, 'entries')).toEqual([]);
});

test('a word saved, then removed elsewhere, leaves the list with nothing shown as failed', async () => {
	await using context = await setup();
	const { browser, entries, id, path } = context;
	const word = entries.word(id);
	await word.open();
	word.inputNote('saved');
	await idle(word);
	browser.drop(path);

	await entries.refresh();
	expect(word.unsettled).toBe(false);
	expect(word.fenced).toBe(true);
	expect(entries.entries).toEqual([]);
});

// ============================================================================
// Repair as exact text, through the same editor
// ============================================================================

test('a tagged word stays listed, opens for exact repair, and saves its note and stage with the repair kept', async () => {
	await using context = await setup();
	const { browser, entries, id, path } = context;
	const broken = await tagged(context);
	browser.put(path, broken);
	await entries.refresh();
	expect(entries.entries).toMatchObject([
		{ id, text: 'lucid', note: '', stage: 'new' },
	]);
	const word = entries.word(id);
	await word.open();

	expect(word.row?.status).toBe('invalid');
	expect(word.repairText()).toBe(broken);
	expect(word.stageable).toBe(false);
	expect(await word.setStage('usable')).toContain('needs repair');
	// The note field takes nothing while the row is not a valid word.
	expect(word.inputNote('mine')).toBeNull();
	expect(await context.file()).toBe(broken);

	const repaired = broken.replace('!book ', '');
	word.inputRepair(repaired);
	expect(word.row?.status).toBe('valid');
	await idle(word);
	expect(await context.file()).toBe(repaired);
	expect(word.row?.status).toBe('valid');

	word.inputNote('mine');
	expect(await word.setStage('usable')).toBeNull();
	const saved = await context.file();
	expect(saved).toContain('"note": "mine"');
	expect(saved).toContain('"source": "Moby Dick"');
	expect(await context.reopened()).toEqual([
		{ text: 'lucid', note: 'mine', stage: 'usable' },
	]);
});

test('repair text is saved in the file’s own line endings', async () => {
	await using context = await setup();
	const { browser, entries, id, path } = context;
	const broken = (await tagged(context)).replaceAll('\n', '\r\n');
	browser.put(path, broken);
	const word = entries.word(id);
	await word.open();
	expect(word.repairText()).toBe(broken.replaceAll('\r\n', '\n'));

	word.inputRepair(word.repairText().replace('!book ', ''));
	await idle(word);
	expect(await context.file()).toBe(broken.replace('!book ', ''));
});

test('Try again after a failed repair sends the repair text exactly, comments and quoting included', async () => {
	await using context = await setup();
	const { browser, entries, id, path } = context;
	const broken = await tagged(context);
	browser.put(path, broken);
	const word = entries.word(id);
	await word.open();
	const repaired = broken.replace(
		'source: !book Moby Dick',
		"source: 'Moby Dick' # a comment",
	);
	context.failWrite('fails');
	word.inputRepair(repaired);
	await idle(word);
	expect(word.save?.status).toBe('failed');
	expect(word.repairText()).toBe(repaired);
	expect(await context.file()).toBe(broken);

	word.retry();
	await idle(word);
	expect(await context.file()).toBe(repaired);
	expect(word.row?.status).toBe('valid');
});

// ============================================================================
// Deleting
// ============================================================================

test('a delete fences every view of the word until it is answered, and nothing writes the word back', async () => {
	await using context = await setup();
	const { entries, holds, id, folder } = context;
	const word = entries.word(id);
	await word.open();
	const answer = Promise.withResolvers<void>();
	holds.deleteAnswer = answer.promise;

	const removing = entries.remove(id);
	await Bun.sleep(5);
	expect(await tableFiles(folder, 'entries')).toEqual([]);
	// The focus list's stage control reaches the same word, and is refused.
	expect(entries.word(id).stageable).toBe(false);
	expect(await entries.word(id).setStage('usable')).toContain('being deleted');
	expect(word.inputNote('typed during the delete')).toContain('being deleted');
	expect(expectErr(await entries.remove(id)).name).toBe('Busy');
	expect(word.note()).toBe('');

	answer.resolve();
	expectOk(await removing);
	expect(holds.deletes).toBe(1);
	expect(entries.entries).toEqual([]);
	expect(await context.reopened()).toEqual([]);
	expect(word.inputNote('after')).toContain('deleted');
});

test('a delete waits for the save already admitted, then removes the word as saved', async () => {
	await using context = await setup();
	const { entries, id, folder } = context;
	const word = entries.word(id);
	await word.open();
	const held = context.holdWrite();

	word.inputNote('saved before the delete');
	await held.started;
	const removing = entries.remove(id);
	await Bun.sleep(5);
	expect(await tableFiles(folder, 'entries')).toHaveLength(1);

	held.release();
	expectOk(await removing);
	expect(await tableFiles(folder, 'entries')).toEqual([]);
	expect(entries.entries).toEqual([]);
});

test('a delete never removes a version of the word this page did not show, and the word then shows that version', async () => {
	await using context = await setup();
	const { browser, entries, holds, id, path } = context;
	const word = entries.word(id);
	await word.open();
	const theirs = (await context.file())?.replace('note: ""', 'note: "theirs"');
	// Another program changes the file, and no hint reaches this page.
	browser.put(path, theirs ?? '');

	expect(expectErr(await entries.remove(id)).name).toBe('Changed');
	expect(holds.deletes).toBe(0);
	expect(await context.file()).toBe(theirs);
	expect(entries.entries[0]?.note).toBe('theirs');
	expect(word.note()).toBe('theirs');
	expect(word.fenced).toBe(false);
});

test('a delete pressed while the word opens is decided by what was listed then, not by what the editor reads later', async () => {
	await using context = await setup();
	const { browser, entries, holds, id, path } = context;
	const word = entries.word(id);
	const opening = Promise.withResolvers<void>();
	holds.edit = opening.promise;
	void word.open();
	const theirs = (await context.file())?.replace('note: ""', 'note: "C"') ?? '';
	browser.put(path, theirs);

	const removing = entries.remove(id);
	opening.resolve();
	expect(expectErr(await removing).name).toBe('Changed');
	expect(holds.deletes).toBe(0);
	expect(await context.file()).toBe(theirs);
});

test('a delete that landed without an answer keeps the word until its file is read again, then lets it go and creates nothing', async () => {
	await using context = await setup();
	const { folder, id, path } = context;
	const entries = await unconfirmedDeletes(context, true);
	const word = entries.word(id);
	await word.open();

	expect(expectErr(await entries.remove(id)).name).toBe('Unconfirmed');
	expect(word.fenced).toBe(false);
	expect(word.deletion).toBeDefined();
	expect(entries.unsettled).toBe(1);
	await entries.refresh();
	expect(entries.entries.map((entry) => entry.id)).toEqual([id]);

	// A save never brings the file back.
	word.inputNote('typed after');
	await idle(word);
	expect(word.missing).toBe(true);
	expect(await word.reload()).toContain('gone');
	expect(await fileText(folder, path)).toBeUndefined();

	await entries.letGo(id);
	expect(entries.entries).toEqual([]);
	expect(entries.unsettled).toBe(0);
	expect(await fileText(folder, path)).toBeUndefined();
	await entries.close();
});

test('a delete that did not land and lost its answer goes on as the word once its file is read again', async () => {
	await using context = await setup();
	const { id } = context;
	const entries = await unconfirmedDeletes(context, false);
	const word = entries.word(id);
	await word.open();

	expect(expectErr(await entries.remove(id)).name).toBe('Unconfirmed');
	expect(word.deletion).toBeDefined();
	expect(await word.reload()).toBeNull();
	expect(word.deletion).toBeUndefined();
	expect(word.unsettled).toBe(false);

	word.inputNote('kept');
	await idle(word);
	expect(await context.reopened()).toEqual([
		{ text: 'lucid', note: 'kept', stage: 'new' },
	]);
	await entries.close();
});

test('a delete that throws instead of answering keeps the word, and a save that lands answers it', async () => {
	await using context = await setup();
	const { folder, id } = context;
	const real = folder.tables.entries;
	const entries = createEntriesState({
		table: {
			...real,
			async delete() {
				throw new Error('the folder did not answer');
			},
		},
	});
	await entries.refresh();
	const word = entries.word(id);
	await word.open();

	expect(expectErr(await entries.remove(id)).name).toBe('Unconfirmed');
	expect(word.deletion).toBeDefined();
	word.inputNote('typed after');
	await until(
		() => word.deletion === undefined,
		'the save to answer the delete',
	);
	expect(await context.reopened()).toEqual([
		{ text: 'lucid', note: 'typed after', stage: 'new' },
	]);
	await entries.close();
});

test('explicit reload fences note input while its saved value is being read', async () => {
	await using context = await setup();
	const word = context.entries.word(context.id);
	await word.open();
	const held = context.holdWrite();
	word.inputNote('saved');
	await held.started;
	const reloading = word.reload();
	expect(word.fenced).toBe(true);
	expect(word.inputNote('late\uD800')).toContain('read again');
	expect(word.note()).toBe('saved');
	held.release();
	expect(await reloading).toBeNull();
	expect(word.fenced).toBe(false);
	expect(word.note()).toBe('saved');
});
