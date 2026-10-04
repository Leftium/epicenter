/**
 * Word draft tests.
 * The real words list and word editor run over Vocab's real browser folder
 * on an in-memory OPFS stand-in, with the table's opening, repair, and delete answers
 * held so each race is played in a fixed order.
 *
 * Key behaviors:
 * - Leaving the note field while the editor opens saves once it has opened
 * - Closing while a word opens lets the late editor go and saves nothing
 * - Deleting a word fences every view of it until the delete is answered,
 *   so nothing writes the word back; a refused delete keeps what was typed
 * - Repair text typed while a repair is out stays, over what was written,
 *   for another explicit repair
 * - A word changed elsewhere into a file that is not a word is shown exactly,
 *   holds leaving the field and stages, and is kept over or repaired only by
 *   the learner's choice
 * - Taking the saved word answers a failed or unknown outcome so typing
 *   saves again; the outcome stays what it was
 *
 * See also:
 * - `entries.test.ts` for adding, listing, and the shared note and stage
 * - `reread.test.ts` for a note saved while typing goes on
 */
import './svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import { FileError, hashBytes } from '@epicenter/folder';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
// Internal to the folder package: a real table over storage this file scripts.
import type { FolderStorage } from '../../../../packages/folder/src/boundary.js';
import { createTable } from '../../../../packages/folder/src/table.js';
import { type VocabTables, vocabFolder } from './data.js';
import {
	createBrowser,
	editWord,
	fileText,
	heldEntries,
	tableFiles,
} from './folder.test-support.js';

const { createEntriesState } = await import('./entries.svelte.js');
const { createWordDraft } = await import('./word.svelte.js');

async function setup() {
	const browser = createBrowser();
	const folder = await browser.open();
	const { holds, table } = heldEntries(folder.tables.entries);
	const entries = createEntriesState({ table });
	expectOk(await entries.add('lucid'));
	const id = entries.entries[0]?.id ?? '';
	const path = `entries/${id}.md`;
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
			const again = createEntriesState({
				table: (await browser.open()).tables.entries,
			});
			await again.refresh();
			return again.entries.map(({ text, note, stage }) => ({
				text,
				note,
				stage,
			}));
		},
		[Symbol.asyncDispose]: () => browser[Symbol.asyncDispose](),
	};
}

/** The word's file with a value that has no canonical form. */
async function tagged(context: Awaited<ReturnType<typeof setup>>) {
	return (
		(await context.file())?.replace(
			'\n---\n',
			'\nsource: !book Moby Dick\n---\n',
		) ?? ''
	);
}

test('leaving the note field while the word opens saves once it has opened', async () => {
	await using context = await setup();
	const { entries, holds, id } = context;
	const opening = Promise.withResolvers<void>();
	holds.edit = opening.promise;
	const word = entries.word(id);

	word.inputNote('typed while opening');
	const leaving = word.blur();
	expect(word.note('')).toBe('typed while opening');
	opening.resolve();
	expect(await leaving).toBeNull();

	expect(word.unsettled).toBe(false);
	expect(await context.reopened()).toEqual([
		{ text: 'lucid', note: 'typed while opening', stage: 'new' },
	]);
});

test('closing while a word opens lets the late editor go and saves nothing', async () => {
	await using context = await setup();
	const { entries, holds, id } = context;
	const opening = Promise.withResolvers<void>();
	holds.edit = opening.promise;
	const word = entries.word(id);
	const before = await context.file();

	word.inputNote('typed, then the page closed');
	const closing = entries.close();
	opening.resolve();
	await closing;

	expect(word.mode.kind).not.toBe('editing');
	expect(await word.blur()).toContain('closing');
	expect(await word.setStage('usable')).toContain('closing');
	expect(await context.file()).toBe(before);
});

test('a delete fences every view of the word until it is answered, and nothing writes the word back', async () => {
	await using context = await setup();
	const { entries, holds, id, folder } = context;
	const word = entries.word(id);
	await word.open();
	const answer = Promise.withResolvers<void>();
	holds.deleteAnswer = answer.promise;

	const removing = entries.remove(id);
	await Bun.sleep(5);
	// The file is gone, and the delete's answer has not come back yet.
	expect(await tableFiles(folder, 'entries')).toEqual([]);
	// The focus list's stage control reaches the same word, and is refused.
	expect(await entries.word(id).setStage('usable')).toContain(
		'being deleted',
	);
	// Nothing typed is taken while the word is being deleted.
	word.inputNote('typed during the delete');
	expect(word.note('')).toBe('');
	expect(word.unsettled).toBe(true);
	expect(await word.blur()).toContain('being deleted');
	expect(await word.saveMine()).toContain('being deleted');

	answer.resolve();
	expectOk(await removing);
	expect(await tableFiles(folder, 'entries')).toEqual([]);
	expect(entries.entries).toEqual([]);
	expect(await context.reopened()).toEqual([]);
});

test('a refused delete gives the word back with the note typed before it', async () => {
	await using context = await setup();
	const { browser, entries, holds, id } = context;
	const word = entries.word(id);
	await word.open();
	const otherTab = createEntriesState({
		table: (await browser.open()).tables.entries,
	});
	await otherTab.refresh();
	expect(await editWord(otherTab, id, { stage: 'recognized' })).toBeNull();

	word.inputNote('kept through a refused delete');
	const answer = Promise.withResolvers<void>();
	holds.deleteAnswer = answer.promise;
	const removing = entries.remove(id);
	await Bun.sleep(5);
	word.inputNote('typed during the delete');
	answer.resolve();
	expect(expectErr(await removing).name).toBe('Changed');

	// The word is back, with the note typed before the delete, and the other
	// tab's change waits for a choice about it.
	expect(word.gated).toBe(false);
	expect(word.note('')).toBe('kept through a refused delete');
	expect(word.review?.kind).toBe('changed');
	expect(await word.saveMine()).toBeNull();
	expect(await context.reopened()).toEqual([
		{ text: 'lucid', note: 'kept through a refused delete', stage: 'new' },
	]);
});

test('repair text typed while a repair is out stays, over what was written, for another explicit repair', async () => {
	await using context = await setup();
	const { entries, folder, holds, id, path } = context;
	const broken = await tagged(context);
	expectOk(await folder.files.overwrite(path, broken));
	const word = entries.word(id);
	await word.open();
	expect(word.mode.kind).toBe('repair');

	const first = broken.replace('!book ', '');
	const newer = first.replace('Moby Dick', 'Moby-Dick');
	word.inputRepair(first);
	const answer = Promise.withResolvers<void>();
	holds.replaceAnswer = answer.promise;
	const repairing = word.writeRepair();
	await Bun.sleep(5);
	word.inputRepair(newer);
	answer.resolve();
	await repairing;
	holds.replaceAnswer = undefined;

	expect(await context.file()).toBe(first);
	expect(word.mode.kind).toBe('repair');
	expect(word.repairText).toBe(newer);
	expect(word.unsettled).toBe(true);

	await word.writeRepair();
	expect(await context.file()).toBe(newer);
	expect(word.mode.kind).toBe('editing');
	expect(word.unsettled).toBe(false);
});

test('a word changed elsewhere into a file that is not a word is shown, and waits for the learner', async () => {
	await using context = await setup();
	const { entries, folder, id, path } = context;
	const word = entries.word(id);
	await word.open();
	word.inputNote('mine');
	const broken = await tagged(context);
	expectOk(await folder.files.overwrite(path, broken));
	await entries.refresh();

	const review = word.review;
	expect(review?.kind === 'invalid' && review.file.source).toBe(broken);
	expect(await word.setStage('usable')).toContain('cannot read as a word');
	expect(await word.blur()).toBeNull();
	expect(await context.file()).toBe(broken);
	expect(word.note('')).toBe('mine');

	// Repairing the file takes its exact text and drops the note typed here.
	await word.repairFile();
	expect(word.mode.kind).toBe('repair');
	expect(word.repairText).toBe(broken);
	expect(word.unsettled).toBe(false);
	expect(await context.file()).toBe(broken);
});

test('keeping my word over a file that is not a word writes the whole word I had', async () => {
	await using context = await setup();
	const { entries, folder, id, path } = context;
	const word = entries.word(id);
	await word.open();
	word.inputNote('mine');
	const broken = await tagged(context);
	expectOk(await folder.files.overwrite(path, broken));
	await entries.refresh();
	expect(word.review?.kind).toBe('invalid');

	expect(await word.saveMine()).toBeNull();
	expect(word.review).toBeUndefined();
	expect(await context.file()).not.toContain('!book');
	expect(await context.reopened()).toEqual([
		{ text: 'lucid', note: 'mine', stage: 'new' },
	]);
});

test('a note typed before the editor opens onto a file that needs repair is shown there, and added once it is repaired', async () => {
	await using context = await setup();
	const { entries, folder, id, path } = context;
	const broken = await tagged(context);
	expectOk(await folder.files.overwrite(path, broken));
	const word = entries.word(id);

	word.inputNote('typed before it opened');
	await word.idle();
	expect(word.mode.kind).toBe('repair');
	expect(word.pendingNote).toBe('typed before it opened');
	expect(word.unsettled).toBe(true);

	word.inputRepair(broken.replace('!book ', ''));
	await word.writeRepair();
	expect(word.mode.kind).toBe('editing');
	expect(word.pendingNote).toBeUndefined();
	expect(word.note('')).toBe('typed before it opened');
	expect(await word.blur()).toBeNull();
	expect(await context.reopened()).toEqual([
		{ text: 'lucid', note: 'typed before it opened', stage: 'new' },
	]);
});

test('a delete that throws instead of answering gives the word back, saves nothing on its own, and the next explicit save works', async () => {
	await using context = await setup();
	const { browser, folder, id } = context;
	const real = folder.tables.entries;
	let throwing = true;
	const entries = createEntriesState({
		table: {
			...real,
			async delete(capture) {
				if (throwing) throw new Error('the folder did not answer');
				return real.delete(capture);
			},
		},
	});
	await entries.refresh();
	const word = entries.word(id);
	await word.open();
	word.inputNote('typed before the delete');

	expect(expectErr(await entries.remove(id)).name).toBe('Unconfirmed');
	expect(word.gated).toBe(false);
	expect(word.outcome?.kind).toBe('deletion');
	expect(word.state?.lastSave).toBeUndefined();
	// Whether the file is gone is not known: leaving the field does not save.
	expect(await word.blur()).toBeNull();
	expect(await fileText(folder, context.path)).not.toContain('typed before');

	expect(await word.saveMine()).toBeNull();
	expect(word.outcome).toBeUndefined();
	throwing = false;
	await entries.close();
	const again = createEntriesState({
		table: (await browser.open()).tables.entries,
	});
	await again.refresh();
	expect(again.entries.map(({ note }) => note)).toEqual([
		'typed before the delete',
	]);
});

for (const landed of [true, false])
	for (const dirty of [false, true])
		test(`a delete answered Unconfirmed that ${landed ? 'landed' : 'did not land'} keeps the ${dirty ? 'dirty' : 'clean'} word, writes nothing on its own, and waits for a choice`, async () => {
			await using context = await setup();
			const { folder, id, path } = context;
			const real = folder.tables.entries;
			const entries = createEntriesState({
				table: {
					...real,
					async delete(capture) {
						if (landed) {
							const removed = await real.delete(capture);
							if (removed.error !== null) return removed;
						}
						return FileError.Unconfirmed({
							path: capture.path,
							operation: 'removing',
							cause: new Error('the answer was lost'),
						});
					},
				},
			});
			await entries.refresh();
			const word = entries.word(id);
			await word.open();
			if (dirty) word.inputNote('unsaved note');
			const exists = async () => (await fileText(folder, path)) !== undefined;

			expect(expectErr(await entries.remove(id)).name).toBe('Unconfirmed');
			expect(word.gated).toBe(false);
			expect(word.outcome?.kind).toBe('deletion');
			expect(word.unsettled).toBe(true);
			expect(entries.unsettled).toBe(1);

			// A read, present or gone, confirms nothing about the delete.
			await entries.refresh();
			expect(entries.entries.map((entry) => entry.id)).toEqual([id]);
			expect(word.state?.observation.kind).toBe(
				landed ? 'missing' : 'present',
			);
			expect(word.outcome?.kind).toBe('deletion');
			// Leaving the field and pressing a stage write nothing by themselves.
			expect(await word.blur()).toBeNull();
			expect(await word.setStage('usable')).toContain('not confirmed');
			expect(await exists()).toBe(!landed);
			expect(word.note('')).toBe(dirty ? 'unsaved note' : '');

			if (landed && !dirty) {
				// Letting it go writes nothing, and the list shows the folder.
				await entries.letGo(id);
				expect(entries.entries).toEqual([]);
				expect(entries.unsettled).toBe(0);
				expect(await exists()).toBe(false);
			} else if (landed) {
				// Saving it back is the learner's choice, and writes it.
				expect(await word.saveMine()).toBeNull();
				expect(word.outcome).toBeUndefined();
				expect(await context.reopened()).toEqual([
					{ text: 'lucid', note: 'unsaved note', stage: 'new' },
				]);
			} else {
				// Taking the saved word answers the delete; typing then saves.
				expect(word.keepSaved()).toBeNull();
				expect(word.outcome).toBeUndefined();
				expect(word.note('')).toBe('');
				word.inputNote('after');
				expect(await word.blur()).toBeNull();
				expect(await context.reopened()).toEqual([
					{ text: 'lucid', note: 'after', stage: 'new' },
				]);
			}
			await entries.close();
		});

// ============================================================================
// An earlier save's outcome beside what the latest read found
// ============================================================================

const WORD = '---\ntext: lucid\nnote: ""\nstage: new\ncreatedAt: "2026-10-01T00:00:00.000Z"\n---\n';

/**
 * A real word editor over storage this test scripts: what reads find, whether
 * reads work, and how the next write is answered.
 */
async function scriptedWord() {
	const disk = {
		content: WORD,
		readable: true,
		answer: 'saved' as 'saved' | 'failed' | 'unknown',
		writes: 0,
	};
	const unused = () => {
		throw new Error('this script only reads and writes one file');
	};
	const storage: FolderStorage = {
		async read(path) {
			if (!disk.readable)
				return FileError.Io({
					path,
					operation: 'read',
					cause: new Error('unreadable now'),
				});
			const bytes = new TextEncoder().encode(disk.content);
			return Ok({ bytes, sha256: await hashBytes(bytes) });
		},
		async apply(changes) {
			disk.writes++;
			const [change] = changes;
			if (change === undefined || change.kind !== 'overwrite') return unused();
			if (disk.answer === 'failed')
				return FileError.Io({
					path: change.path,
					operation: 'write',
					cause: new Error('disk full'),
				});
			disk.content = new TextDecoder().decode(change.bytes);
			if (disk.answer === 'unknown')
				return FileError.Unconfirmed({
					path: change.path,
					operation: 'publishing',
					cause: new Error('the answer was lost'),
				});
			return Ok(undefined);
		},
		list: unused,
		children: unused,
		readMany: unused,
		open: unused,
		mkdir: unused,
		rmdir: unused,
	};
	const table: VocabTables['entries'] = createTable(
		{ storage, onFilesChanged: () => () => {} },
		'entries',
		vocabFolder.tables.entries.fields,
	);
	const word = createWordDraft({ table, id: 'one', onSaved: () => {} });
	await word.open();
	return { disk, word };
}

const CHANGED = WORD.replace('note: ""', 'note: "theirs"');
const INVALID = WORD.replace('\n---\n', '\nsource: !book Moby Dick\n---\n');

for (const outcome of ['failed', 'unknown'] as const)
	for (const [read, kind] of [
		['an unreadable file', 'unreadable'],
		['a file that is not a word', 'invalid'],
		['another tab’s note', 'changed'],
	] as const)
		test(`after a ${outcome} save, ${read} still holds leaving the field and stages`, async () => {
			const { disk, word } = await scriptedWord();
			disk.answer = outcome;
			word.inputNote('first');
			await word.blur();
			const history = word.state?.lastSave;
			expect(word.outcome?.kind).toBe(
				outcome === 'failed' ? 'failed' : 'unconfirmed',
			);
			// Typing goes on, then the file changes elsewhere and is read here.
			word.inputNote('second');
			if (kind === 'unreadable') disk.readable = false;
			else disk.content = kind === 'invalid' ? INVALID : CHANGED;
			await word.refresh();
			disk.answer = 'saved';
			const writes = disk.writes;
			const content = disk.content;

			// The outcome is still shown, and so is what the read found.
			expect(word.outcome).toBeDefined();
			expect(word.review?.kind).toBe(kind);
			expect(await word.setStage('usable')).not.toBeNull();
			expect(await word.blur()).toBeNull();
			expect(disk.writes).toBe(writes);
			if (kind !== 'unreadable') expect(disk.content).toBe(content);
			expect(word.state?.lastSave).toBe(history);

			if (kind === 'unreadable') {
				// It cannot be reviewed, so even the explicit save writes nothing.
				expect(await word.saveMine()).toContain('cannot be read');
				expect(disk.writes).toBe(writes);
			} else if (kind === 'changed') {
				// Taking the saved word answers the outcome; typing then saves.
				expect(word.keepSaved()).toBeNull();
				expect(word.outcome).toBeUndefined();
				expect(word.state?.lastSave).toBe(history);
				expect(word.note('')).toBe('theirs');
				word.inputNote('third');
				expect(await word.blur()).toBeNull();
				expect(disk.writes).toBe(writes + 1);
				expect(disk.content).toContain('"note": "third"');
			} else {
				// Keeping my word over the reviewed file is an explicit save.
				expect(await word.saveMine()).toBeNull();
				expect(disk.writes).toBe(writes + 1);
				expect(disk.content).toContain('"note": "second"');
				expect(word.outcome).toBeUndefined();
			}
			await word.dispose();
		});

test('a matching read alone does not answer an unknown outcome', async () => {
	const { disk, word } = await scriptedWord();
	disk.answer = 'unknown';
	word.inputNote('first');
	await word.blur();
	await word.refresh();
	disk.answer = 'saved';
	// The read holds this page's text; the outcome is still unknown.
	expect(word.state?.observation.kind).toBe('present');
	expect(word.outcome?.kind).toBe('unconfirmed');
	word.inputNote('second');
	expect(await word.blur()).toBeNull();
	expect(disk.writes).toBe(1);
	await word.dispose();
});
