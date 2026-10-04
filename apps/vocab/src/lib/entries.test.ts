/**
 * Saved word tests.
 * The real entries state runs over Vocab's real browser folder on an in-memory OPFS stand-in. "Saved" is read back from the file, and from the folder opened
 * again, never assumed from the list on screen.
 *
 * Key behaviors:
 * - A word is listed once its file exists, with a blank note and the New
 *   stage, and is there when the folder is opened again
 * - Text is trimmed and otherwise exact, whatever its script or spelling
 * - A phrase with the exact text of a saved word writes nothing and leaves
 *   that word's note and stage alone
 * - Note and stage share one editor per word: a stage pressed while a note is
 *   typed saves both, and each save writes the whole word
 * - A word read here after another tab's edit follows it when nothing is
 *   typed; a save overwrites an edit that was never read here
 * - A removal of a word that changed elsewhere is refused, and the other
 *   change is kept
 * - A word whose file cannot open as a row is repaired as exact text
 * - A closed folder answers with an error and lists nothing new
 * - A row file that cannot be read as a word is reported, never dropped
 */
import './svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	createBrowser,
	editWord,
	fileText,
	gated,
	tableFiles,
} from './folder.test-support.js';

const { createEntriesState } = await import('./entries.svelte.js');

async function setup() {
	const browser = createBrowser();
	const folder = await browser.open();
	const entries = createEntriesState({ table: folder.tables.entries });
	await entries.refresh();
	return {
		browser,
		folder,
		entries,
		/** The words a reload would list, from a folder opened again. */
		async reopened() {
			const again = createEntriesState({
				table: (await browser.open()).tables.entries,
			});
			await again.refresh();
			return again;
		},
		[Symbol.asyncDispose]: () => browser[Symbol.asyncDispose](),
	};
}

const summary = (state: {
	entries: readonly { text: string; note: string; stage: string }[];
}) => state.entries.map(({ text, note, stage }) => ({ text, note, stage }));

test('a word is listed once its file exists, with a blank note and the New stage, and is there after reopening', async () => {
	await using context = await setup();
	const { folder, entries } = context;

	const adding = entries.add('  lucid  ');
	// Not listed on the request alone: only the folder's receipt lists it.
	expect(entries.entries).toEqual([]);
	expect(expectOk(await adding)).toBe('added');
	expect(summary(entries)).toEqual([{ text: 'lucid', note: '', stage: 'new' }]);

	const [path] = await tableFiles(folder, 'entries');
	expect(path).toBe(`entries/${entries.entries[0]?.id}.md`);
	expect(await fileText(folder, path ?? '')).toBe(
		entries.entries[0]?.file.text,
	);
	expect(summary(await context.reopened())).toEqual([
		{ text: 'lucid', note: '', stage: 'new' },
	]);
});

test('text is trimmed and otherwise exact in any script or spelling', async () => {
	await using context = await setup();
	const { entries } = context;
	const texts = [
		'\u00e9 和 \u00e9。',
		// The same letters spelled with a combining accent are another phrase.
		'e\u0301 和 e\u0301。',
		'银行，顺便买',
		'naïve — “quoted”: yes',
		'مرحبا بالعالم',
		'👩🏽‍🚀 to the 🌕',
		'a: b # not a comment',
	];

	expect(expectErr(await entries.add('   ')).name).toBe('Empty');
	for (const text of texts)
		expect(expectOk(await entries.add(text))).toBe('added');
	expect(entries.entries.map((entry) => entry.text).sort()).toEqual(
		[...texts].sort(),
	);
	expect(
		(await context.reopened()).entries.map((entry) => entry.text).sort(),
	).toEqual([...texts].sort());
});

test('a phrase with the exact text of a saved word writes nothing and leaves its note and stage alone', async () => {
	await using context = await setup();
	const { folder, entries } = context;

	expectOk(await entries.add('by and large'));
	const [entry] = entries.entries;
	if (!entry) throw new Error('the word was not added');
	expect(
		await editWord(entries, entry.id, {
			note: 'mostly; on the whole',
			stage: 'understood',
		}),
	).toBeNull();
	const before = await fileText(folder, entry.file.path);

	expect(expectOk(await entries.add(' by and large '))).toBe('present');
	expect(await tableFiles(folder, 'entries')).toHaveLength(1);
	expect(await fileText(folder, entry.file.path)).toBe(before);
	expect(summary(entries)).toEqual([
		{ text: 'by and large', note: 'mostly; on the whole', stage: 'understood' },
	]);
});

test('a stage pressed while a note is typed saves both, from one editor shared by every view', async () => {
	await using context = await setup();
	const { entries, folder } = context;
	expectOk(await entries.add('candid'));
	const id = entries.entries[0]?.id ?? '';
	const card = entries.word(id);
	// The focus list's stage control reaches the same editor.
	expect(entries.word(id)).toBe(card);
	await card.open();

	card.inputNote('honest,\nand a second line: "quoted"');
	expect(await entries.word(id).setStage('usable')).toBeNull();
	// The stage did not reset the note, and the note was saved with it.
	expect(card.note('')).toBe('honest,\nand a second line: "quoted"');
	expect(card.unsettled).toBe(false);

	const expected = [
		{
			text: 'candid',
			note: 'honest,\nand a second line: "quoted"',
			stage: 'usable',
		},
	];
	expect(summary(entries)).toEqual(expected);
	expect(summary(await context.reopened())).toEqual(expected);
	// The whole word, in canonical form, with what it had before.
	const source = await fileText(folder, `entries/${id}.md`);
	expect(source).toStartWith('---\n"text": "candid"\n"note": ');
	expect(entries.entries[0]?.file.text).toBe(source);
});

test('a word read here after another tab’s edit follows it when nothing is typed, and a stage pressed here keeps that note', async () => {
	await using context = await setup();
	const { browser, entries } = context;
	expectOk(await entries.add('nuance'));
	const id = entries.entries[0]?.id ?? '';
	await entries.word(id).open();

	const otherTab = createEntriesState({
		table: (await browser.open()).tables.entries,
	});
	await otherTab.refresh();
	expect(await editWord(otherTab, id, { note: 'a subtle difference' })).toBe(
		null,
	);

	// The other tab's hint is read here.
	await entries.refresh();
	expect(entries.word(id).note('')).toBe('a subtle difference');
	expect(await entries.word(id).setStage('recognized')).toBeNull();
	expect(summary(await context.reopened())).toEqual([
		{ text: 'nuance', note: 'a subtle difference', stage: 'recognized' },
	]);
});

test('a save here overwrites another tab’s edit that was never read here', async () => {
	await using context = await setup();
	const { browser, entries } = context;
	expectOk(await entries.add('nuance'));
	const id = entries.entries[0]?.id ?? '';
	await entries.word(id).open();

	const otherTab = createEntriesState({
		table: (await browser.open()).tables.entries,
	});
	await otherTab.refresh();
	expect(await editWord(otherTab, id, { note: 'theirs' })).toBeNull();

	// No hint was read here: the stage saves this tab's whole word.
	expect(await entries.word(id).setStage('usable')).toBeNull();
	expect(summary(await context.reopened())).toEqual([
		{ text: 'nuance', note: '', stage: 'usable' },
	]);
});

test('removing deletes exactly the word shown, and refuses one that changed elsewhere', async () => {
	await using context = await setup();
	const { browser, folder, entries } = context;
	expectOk(await entries.add('resilient'));
	expectOk(await entries.add('ambiguous'));
	const byText = (text: string) =>
		entries.entries.find((entry) => entry.text === text)?.id ?? '';

	const otherTab = createEntriesState({
		table: (await browser.open()).tables.entries,
	});
	await otherTab.refresh();
	expect(
		await editWord(otherTab, byText('resilient'), { stage: 'usable' }),
	).toBeNull();

	expect(expectErr(await entries.remove(byText('resilient'))).name).toBe(
		'Changed',
	);
	expect(await tableFiles(folder, 'entries')).toHaveLength(2);

	expectOk(await entries.remove(byText('ambiguous')));
	expect(summary(entries)).toEqual([
		{ text: 'resilient', note: '', stage: 'usable' },
	]);
	expect(summary(await context.reopened())).toEqual([
		{ text: 'resilient', note: '', stage: 'usable' },
	]);
	// A word the other tab still lists is already gone: that is not a failure.
	expectOk(
		await otherTab.remove(
			otherTab.entries.find((entry) => entry.text === 'ambiguous')?.id ?? '',
		),
	);
});

test('a refused save lists nothing, and saving again adds one file', async () => {
	await using context = await setup();
	const { folder } = context;
	const { gate, table } = gated(folder.tables.entries);
	const entries = createEntriesState({ table });

	gate.failing = true;
	expect(expectErr(await entries.add('subtle')).name).toBe('NotSaved');
	expect(entries.entries).toEqual([]);
	expect(await tableFiles(folder, 'entries')).toEqual([]);

	gate.failing = false;
	expect(expectOk(await entries.add('subtle'))).toBe('added');
	expect(expectOk(await entries.add('subtle'))).toBe('present');
	expect(await tableFiles(folder, 'entries')).toHaveLength(1);
});

test('a closed folder answers with an error for a new word, an edit, and a removal', async () => {
	await using context = await setup();
	const { folder, entries } = context;
	expectOk(await entries.add('in hindsight'));
	const id = entries.entries[0]?.id ?? '';
	const word = entries.word(id);
	await word.open();
	await folder.close();

	expect(expectErr(await entries.add('on the fence')).name).toBe('NotSaved');
	// The note is kept, the failure is shown, and leaving again resends nothing.
	word.inputNote('looking back');
	expect(await word.blur()).not.toBeNull();
	expect(word.outcome?.kind).toBe('failed');
	expect(word.note('')).toBe('looking back');
	expect(word.unsettled).toBe(true);
	expect(await word.blur()).toBeNull();
	expect(expectErr(await entries.remove(id)).name).toBe('NotSaved');
	expect(summary(entries)).toEqual([
		{ text: 'in hindsight', note: '', stage: 'new' },
	]);
	await entries.refresh();
	expect(entries.loadError).not.toBeNull();
	// The file is as it was.
	expect(summary(await context.reopened())).toEqual([
		{ text: 'in hindsight', note: '', stage: 'new' },
	]);
});

test('a row file that cannot be read as a word is reported with its path and left as it is', async () => {
	await using context = await setup();
	const { folder, entries } = context;
	expectOk(await entries.add('cut to the chase'));
	const unparsed = 'no frontmatter here\n';
	const wrongStage =
		'---\ntext: lucid\nnote: ""\nstage: mastered\ncreatedAt: 2026-10-03T00:00:00.000Z\n---\n';
	expectOk(await folder.files.create('entries/unparsed.md', unparsed));
	expectOk(await folder.files.create('entries/wrong-stage.md', wrongStage));

	await entries.refresh();
	expect(summary(entries)).toEqual([
		{ text: 'cut to the chase', note: '', stage: 'new' },
	]);
	expect(entries.unreadable.map((file) => file.path).sort()).toEqual([
		'entries/unparsed.md',
		'entries/wrong-stage.md',
	]);
	expect(entries.unreadable.every((file) => file.reason.length > 0)).toBe(true);
	expect(await fileText(folder, 'entries/unparsed.md')).toBe(unparsed);
	expect(await fileText(folder, 'entries/wrong-stage.md')).toBe(wrongStage);
});

// ============================================================================
// One file per exact text
// ============================================================================

test('adds of one text made together, in one tab or two, save one word', async () => {
	await using context = await setup();
	const { browser, folder, entries } = context;
	const otherTab = createEntriesState({
		table: (await browser.open()).tables.entries,
	});
	await otherTab.refresh();

	// None of these sees another's word in its list before it asks the folder.
	const outcomes = await Promise.all([
		entries.add('on the fence'),
		entries.add(' on the fence '),
		otherTab.add('on the fence'),
	]);
	expect(outcomes.map((outcome) => expectOk(outcome)).sort()).toEqual([
		'added',
		'present',
		'present',
	]);
	expect(await tableFiles(folder, 'entries')).toHaveLength(1);
	const one = [{ text: 'on the fence', note: '', stage: 'new' }];
	expect(summary(entries)).toEqual(one);
	// The tab that found the file lists it without waiting for a read.
	expect(summary(otherTab)).toEqual(one);
	expect(summary(await context.reopened())).toEqual(one);

	// A different text, however close, is another word.
	expect(expectOk(await entries.add('On the fence'))).toBe('added');
	expect(await tableFiles(folder, 'entries')).toHaveLength(2);
});

test('a save that landed without its answer is found by the retry, with the note and stage it has by then', async () => {
	await using context = await setup();
	const { browser, folder } = context;
	const { gate, table } = gated(folder.tables.entries);
	const entries = createEntriesState({ table });

	gate.losingReceipt = true;
	expect(expectErr(await entries.add('by the way 顺便')).name).toBe('NotSaved');
	// The word is not listed, and its file is there all the same.
	expect(entries.entries).toEqual([]);
	const files = await tableFiles(folder, 'entries');
	expect(files).toHaveLength(1);

	// Another tab, which read the folder, has since made the word its own.
	const otherTab = createEntriesState({
		table: (await browser.open()).tables.entries,
	});
	await otherTab.refresh();
	const id = otherTab.entries[0]?.id ?? '';
	expect(
		await editWord(otherTab, id, { note: 'in passing', stage: 'understood' }),
	).toBeNull();

	// The retry still has an empty list: no hint and no read reached it.
	expect(expectOk(await entries.add('by the way 顺便'))).toBe('present');
	expect(await tableFiles(folder, 'entries')).toEqual(files);
	const kept = [
		{ text: 'by the way 顺便', note: 'in passing', stage: 'understood' },
	];
	expect(summary(entries)).toEqual(kept);
	expect(summary(await context.reopened())).toEqual(kept);
});

test('a different file where a new word belongs is refused and left as it is', async () => {
	await using context = await setup();
	const { folder, entries } = context;
	expectOk(await entries.add('lucid'));
	const [path] = await tableFiles(folder, 'entries');
	if (!path) throw new Error('the word was not added');
	// Another program rewrote the file to hold another word.
	const other = entries.entries[0]?.file.text.replace('lucid', 'lurid') ?? '';
	expectOk(await folder.files.overwrite(path, other));

	const stale = createEntriesState({ table: folder.tables.entries });
	expect(expectErr(await stale.add('lucid')).name).toBe('Taken');
	expect(stale.entries).toEqual([]);
	expect(await fileText(folder, path)).toBe(other);
});

test('a word another tab removed, with no hint yet read here, is saved again instead of being called present', async () => {
	await using context = await setup();
	const { browser, folder, entries } = context;
	expectOk(await entries.add('resilient'));
	// A word whose file is not named by its text, as one written elsewhere may be.
	expectOk(
		await folder.tables.entries.create({
			stem: 'earlier-id',
			fields: {
				text: 'ambiguous',
				note: 'unclear',
				stage: 'usable',
				createdAt: entries.entries[0]?.createdAt as never,
			},
		}),
	);
	await entries.refresh();
	expect(entries.has('resilient') && entries.has('ambiguous')).toBe(true);

	// Still there: present, read from the folder, with nothing written.
	expect(expectOk(await entries.add('ambiguous'))).toBe('present');
	expect(await tableFiles(folder, 'entries')).toHaveLength(2);

	// Another tab removes both. This tab's list still shows them.
	const otherTab = createEntriesState({
		table: (await browser.open()).tables.entries,
	});
	await otherTab.refresh();
	for (const entry of otherTab.entries)
		expectOk(await otherTab.remove(entry.id));
	expect(await tableFiles(folder, 'entries')).toEqual([]);
	expect(entries.has('resilient') && entries.has('ambiguous')).toBe(true);

	expect(expectOk(await entries.add('resilient'))).toBe('added');
	expect(expectOk(await entries.add('ambiguous'))).toBe('added');
	expect(await tableFiles(folder, 'entries')).toHaveLength(2);
	// Each is one new word, not the removed one: blank note, New stage.
	const fresh = [
		{ text: 'ambiguous', note: '', stage: 'new' },
		{ text: 'resilient', note: '', stage: 'new' },
	];
	const byText = (state: Parameters<typeof summary>[0]) =>
		summary(state).sort((a, b) => a.text.localeCompare(b.text));
	expect(byText(entries)).toEqual(fresh);
	expect(byText(await context.reopened())).toEqual(fresh);
});

test('a stage is refused while another tab’s note, read here, waits for a choice about the note typed here', async () => {
	await using context = await setup();
	const { browser, entries } = context;
	expectOk(await entries.add('candid'));
	const id = entries.entries[0]?.id ?? '';
	const word = entries.word(id);
	await word.open();
	const otherTab = createEntriesState({
		table: (await browser.open()).tables.entries,
	});
	await otherTab.refresh();

	word.inputNote('honest');
	expect(await editWord(otherTab, id, { note: 'frank' })).toBeNull();
	await entries.refresh();
	expect(word.review?.kind).toBe('changed');
	expect(await word.setStage('recognized')).toContain('changed in another tab');
	expect(word.note('')).toBe('honest');
	const kept = [{ text: 'candid', note: 'frank', stage: 'new' }];
	expect(summary(await context.reopened())).toEqual(kept);

	// Keeping the saved note takes the other tab's word; the stage then saves.
	expect(word.keepSaved()).toBeNull();
	expect(word.note('')).toBe('frank');
	expect(await word.setStage('recognized')).toBeNull();
	expect(summary(await context.reopened())).toEqual([
		{ text: 'candid', note: 'frank', stage: 'recognized' },
	]);
});

test('a word whose file cannot open as a row is repaired as exact text, and then edits again', async () => {
	await using context = await setup();
	const { folder, entries } = context;
	expectOk(await entries.add('lucid'));
	const id = entries.entries[0]?.id ?? '';
	const path = `entries/${id}.md`;
	// Another program adds a value with a custom tag: the fields still read,
	// but the file has no canonical form, so it does not open in an editor.
	const tagged =
		(await fileText(folder, path))?.replace(
			'\n---\n',
			'\nsource: !book Moby Dick\n---\n',
		) ?? '';
	expectOk(await folder.files.overwrite(path, tagged));
	await entries.refresh();
	expect(summary(entries)).toEqual([{ text: 'lucid', note: '', stage: 'new' }]);

	const word = entries.word(id);
	await word.open();
	expect(word.mode.kind).toBe('repair');
	expect(word.repairText).toBe(tagged);
	expect(await word.setStage('usable')).toContain('needs repair');
	expect(await fileText(folder, path)).toBe(tagged);

	const repaired = tagged.replace('!book ', '');
	word.inputRepair(repaired);
	await word.writeRepair();
	expect(await fileText(folder, path)).toBe(repaired);
	expect(word.mode.kind).toBe('editing');
	expect(await word.setStage('usable')).toBeNull();
	// The repaired metadata Vocab does not declare is kept by the save.
	expect(await fileText(folder, path)).toContain('"source": "Moby Dick"');
	expect(summary(await context.reopened())).toEqual([
		{ text: 'lucid', note: '', stage: 'usable' },
	]);
});
