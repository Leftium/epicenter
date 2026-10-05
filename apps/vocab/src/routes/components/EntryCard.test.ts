/**
 * Entry card tests.
 * The real `EntryCard` is mounted in jsdom over the real words list and each
 * word's real row editor, on Vocab's real browser folder over an in-memory
 * OPFS stand-in that can fail a write or be changed the way another program
 * would. Typing and pressing buttons are DOM events. This shows what a
 * delivered event does; jsdom has no layout, focus, selection, or IME, so it
 * says nothing about whether a person can deliver it.
 *
 * Key behaviors:
 * - A shown card opens its word, and a card given another word opens that
 *   one; the note field is disabled until the word opens
 * - "Reload file" shows a change saved elsewhere while the word was open
 * - A note no file can hold stays in the field with why, holds Delete and
 *   Reload file, and goes only when discarded
 * - A card given another word, then the first again, edits whichever word it
 *   shows, in the same field; no note crosses between words
 * - A card that is gone takes nothing from its retained field or buttons
 * - Each keystroke saves the note; a stage press saves the note as typed
 * - A failed save keeps the learner's text in the field; later typing saves
 *   again, and reloading the file can discard it
 * - A file that is gone keeps the learner's text and offers no way to save it
 *   back, only to let it go
 * - A file that is not a valid word is edited as exact text, in its own line
 *   endings, and stays in view until the learner returns to the note
 * - A repair field that was removed stays inert after the word shows a new
 *   one: each field has its own lifetime
 * - After an unconfirmed delete that landed, "Check again" shows the file is
 *   gone and "Let it go" removes the word without creating anything
 * - The focus list offers stages only while the word is a valid row
 *
 * See also:
 * - `../../lib/word.test.ts` for the word's owner on its own
 */
import './svelte-dom.test-support.js';
import { expect, test } from 'bun:test';
import { FileError } from '@epicenter/folder';
import { expectOk } from 'wellcrafted/testing';
import type { Entry } from '../../lib/data.js';
import {
	createBrowser,
	fileText,
	heldEntries,
} from '../../lib/folder.test-support.js';
import { button, click, type } from './svelte-dom.test-support.js';

const { flushSync, mount, unmount } = await import('svelte');
const { createEntriesState } = await import('../../lib/entries.svelte.js');
const { cardProps } = await import('./card-props.test-support.svelte.js');
const { default: EntryCard } = await import('./EntryCard.svelte');

/** Let the folder answer and the card catch up. */
async function until(done: () => boolean, what: string) {
	for (let attempt = 0; attempt < 200; attempt++) {
		flushSync();
		if (done()) return;
		await Bun.sleep(2);
	}
	throw new Error(`Timed out waiting for ${what}`);
}

async function setup(
	texts: string[],
	{
		landDeletesUnconfirmed = false,
		opening,
	}: {
		landDeletesUnconfirmed?: boolean;
		/** Opening a word's editor waits for this. */
		opening?: Promise<void>;
	} = {},
) {
	const browser = createBrowser();
	const folder = await browser.open();
	const { holds, table: real } = heldEntries(folder.tables.entries);
	holds.edit = opening;
	// Deletes that land and lose their answer, when a test asks for them.
	const entries = createEntriesState({
		table: !landDeletesUnconfirmed
			? real
			: {
					...real,
					async delete(stem, options) {
						const removed = await real.delete(stem, options);
						if (removed.error !== null) return removed;
						return FileError.Unconfirmed({
							path: `entries/${stem}.md`,
							operation: 'removing',
							cause: new Error('the answer was lost'),
						});
					},
				},
	});
	for (const text of texts) expectOk(await entries.add(text));
	const byText = (text: string): Entry => {
		const entry = entries.entries.find((candidate) => candidate.text === text);
		if (entry === undefined) throw new Error(`${text} is not listed`);
		return entry;
	};
	const first = byText(texts[0] ?? '');
	const props = cardProps(entries, first);
	const target = document.createElement('div');
	document.body.append(target);
	const card = mount(EntryCard, { target, props });
	flushSync();
	let mounted = true;
	const destroy = () => {
		if (!mounted) return;
		mounted = false;
		void unmount(card);
		target.remove();
	};
	const { faults } = browser.opfs;
	return {
		browser,
		folder,
		entries,
		props,
		target,
		byText,
		destroy,
		/** The word's editor, once the open its card started has finished. */
		async opened(text: string) {
			const word = entries.word(byText(text).id);
			await word.open();
			flushSync();
			return word;
		},
		path: (text: string) => `entries/${byText(text).id}.md`,
		file: (text: string) => fileText(folder, `entries/${byText(text).id}.md`),
		/** The textarea labelled `label`, if one is shown. */
		field: (label: string) =>
			target.querySelector<HTMLTextAreaElement>(
				`textarea[aria-label="${label}"]`,
			) ?? undefined,
		/** The next write of `text`'s file fails. */
		failWrite(text: string) {
			const path = `entries/${byText(text).id}.md`;
			faults.write = (key) => {
				if (!key.endsWith(path)) return;
				faults.write = undefined;
				return 'fail';
			};
		},
		async [Symbol.asyncDispose]() {
			destroy();
			await entries.close();
			await browser[Symbol.asyncDispose]();
		},
	};
}

/** The word's file with a value that has no canonical form. */
const tagged = (text: string) =>
	text.replace('\n---\n', '\nsource: !book Moby Dick\n---\n');

test('a shown card opens its word without a focus, its note field disabled until then, and a card given another word opens that one', async () => {
	const opening = Promise.withResolvers<void>();
	await using context = await setup(['lucid', 'candid'], {
		opening: opening.promise,
	});
	const { entries, props, byText, field } = context;
	const note = field('Your note for lucid');
	expect(note?.disabled).toBe(true);
	expect(note?.placeholder).toBe('Opening…');
	expect(entries.word(byText('lucid').id).opening).toBe(true);

	opening.resolve();
	await until(() => note?.disabled === false, 'the word to open');
	expect(entries.word(byText('lucid').id).row?.status).toBe('valid');
	expect(entries.word(byText('candid').id).row).toBeUndefined();

	// Given another word, the card opens that word, and typing reaches it.
	props.entry = byText('candid');
	await until(
		() =>
			entries.word(byText('candid').id).row !== undefined &&
			field('Your note for candid')?.disabled === false,
		'the other word to open',
	);
	type(field('Your note for candid'), 'typed at once');
	await until(
		() =>
			entries.entries.find((e) => e.text === 'candid')?.note ===
			'typed at once',
		'the note to save',
	);
	expect(await context.file('lucid')).not.toContain('typed at once');
});

test('Reload file shows a change another program saved while the word was open', async () => {
	await using context = await setup(['lucid']);
	const { browser, field, target } = context;
	const word = await context.opened('lucid');
	const theirs =
		(await context.file('lucid'))?.replace('note: ""', 'note: "theirs"') ?? '';
	expect(theirs).toContain('theirs');
	browser.put(context.path('lucid'), theirs);
	const note = field('Your note for lucid');
	// Read once: the open word does not follow the file by itself.
	await Bun.sleep(10);
	expect(note?.value).toBe('');

	click(target, 'Reload file');
	await until(() => note?.value === 'theirs', 'the file to be shown');
	expect(word.save?.status).toBe('idle');
	expect(await context.file('lucid')).toBe(theirs);
});

test('a note no file can hold stays in the field with why, holds Delete and Reload file, and goes only when discarded', async () => {
	await using context = await setup(['lucid']);
	const { entries, field, target } = context;
	const word = await context.opened('lucid');
	const before = await context.file('lucid');
	const note = field('Your note for lucid');

	type(note, 'half a pair: \uD800');
	flushSync();
	expect(note?.value).toBe('half a pair: \uD800');
	expect(target.textContent).toContain('cannot be saved as typed');
	expect(button(target, 'Reload file')?.disabled).toBe(true);
	click(target, 'Delete');
	await Bun.sleep(10);
	expect(entries.entries).toHaveLength(1);
	expect(await context.file('lucid')).toBe(before);
	expect(note?.value).toBe('half a pair: \uD800');
	expect(entries.unsettled).toBe(1);

	click(target, 'Discard this note');
	flushSync();
	expect(note?.value).toBe('');
	expect(target.textContent).not.toContain('cannot be saved as typed');
	expect(word.unsettled).toBe(false);
	expect(await context.file('lucid')).toBe(before);
});

test('a card given another word, then the first again, edits the word it shows in the same field', async () => {
	await using context = await setup(['lucid', 'candid']);
	const { entries, props, byText, field } = context;
	await context.opened('lucid');
	await context.opened('candid');
	const note = field('Your note for lucid');
	type(note, 'about lucid');

	props.entry = byText('candid');
	flushSync();
	// The same field now shows the other word's note, not the one typed.
	const same = field('Your note for candid');
	expect(same).toBe(note);
	expect(same?.value).toBe('');
	type(same, 'about candid');

	props.entry = byText('lucid');
	flushSync();
	expect(field('Your note for lucid')).toBe(note);
	expect(note?.value).toBe('about lucid');
	await until(
		() =>
			entries.entries.find((e) => e.text === 'lucid')?.note === 'about lucid' &&
			entries.entries.find((e) => e.text === 'candid')?.note === 'about candid',
		'both notes to save',
	);

	// A stage pressed now is the shown word's alone.
	click(context.target, 'Understand');
	await until(
		() =>
			entries.entries.find((e) => e.text === 'lucid')?.stage === 'understood',
		'the stage to save',
	);
	expect(await context.file('candid')).toContain('"stage": "new"');
});

test('a card that is gone takes nothing from its retained field or buttons, and the word keeps its own note', async () => {
	await using context = await setup(['lucid']);
	const { field, target } = context;
	const word = await context.opened('lucid');
	const note = field('Your note for lucid');
	type(note, 'typed before it went');
	await until(() => word.save?.status === 'idle', 'the note to save');
	const stage = button(target, 'Use');
	const before = await context.file('lucid');

	context.destroy();
	// The elements are detached but their listeners remain; deliver to them.
	type(note, 'typed after it went');
	if (stage === undefined) throw new Error('No stage button');
	click(target, stage);
	await Bun.sleep(10);

	expect(word.note()).toBe('typed before it went');
	expect(await context.file('lucid')).toBe(before);
});

test('each keystroke saves the note, and a stage press saves the note as typed with it', async () => {
	await using context = await setup(['lucid']);
	const { entries, field, target } = context;
	await context.opened('lucid');
	const note = field('Your note for lucid');
	type(note, 'clear\nand bright');
	await until(
		() => entries.entries[0]?.note === 'clear\nand bright',
		'the note',
	);

	type(note, 'clear, bright, and easy');
	click(target, 'Recognize');
	await until(() => entries.entries[0]?.stage === 'recognized', 'the stage');
	expect(entries.entries[0]?.note).toBe('clear, bright, and easy');
	expect(button(target, 'Recognize')?.getAttribute('aria-pressed')).toBe(
		'true',
	);
});

test('a failed save keeps the text in the field and later typing saves the latest', async () => {
	await using context = await setup(['lucid']);
	const { field, target } = context;
	const word = await context.opened('lucid');
	const note = field('Your note for lucid');
	context.failWrite('lucid');
	type(note, 'my note');
	await until(() => word.save?.status === 'failed', 'the save to fail');
	expect(target.textContent).toContain('Your last change was not saved');

	type(note, 'my note, and more');
	await until(() => word.save?.status === 'idle', 'the later edit to land');
	expect(note?.value).toBe('my note, and more');
	expect(await context.file('lucid')).toContain('"note": "my note, and more"');
	expect(target.textContent).not.toContain('Your last change was not saved');
});

test('discarding a failed change reloads the file into the field', async () => {
	await using context = await setup(['lucid']);
	const { field, target } = context;
	const word = await context.opened('lucid');
	const note = field('Your note for lucid');
	context.failWrite('lucid');
	type(note, 'not kept');
	await until(() => word.save?.status === 'failed', 'the save to fail');

	click(target, 'Discard mine and reload the file');
	await until(
		() => word.save?.status === 'idle' && note?.value === '',
		'the file to be shown',
	);
	expect(target.textContent).not.toContain('not saved');
});

test('a file that is gone keeps the learner’s text and offers no way to save it back, only to let it go', async () => {
	await using context = await setup(['lucid']);
	const { browser, entries, field, folder, target } = context;
	const word = await context.opened('lucid');
	const path = context.path('lucid');
	browser.drop(path);
	const note = field('Your note for lucid');
	type(note, 'kept');
	await until(() => word.missing, 'the save to find the file gone');

	expect(target.textContent).toContain('gone');
	expect(note?.value).toBe('kept');
	expect(button(target, 'Try again')).toBeUndefined();
	expect(button(target, 'Understand')?.disabled).toBe(true);
	click(target, 'Let it go');
	await until(() => entries.entries.length === 0, 'the word to be let go');
	expect(await fileText(folder, path)).toBeUndefined();
});

test('a file that is not a valid word is edited as exact text in its own line endings, and stays in view until the learner returns to the note', async () => {
	await using context = await setup(['lucid']);
	const { browser, entries, field, target } = context;
	const broken = tagged((await context.file('lucid')) ?? '').replace(
		/\n/g,
		'\r\n',
	);
	browser.put(context.path('lucid'), broken);
	// The card opened the word already; the broken file shows once reloaded.
	const word = await context.opened('lucid');
	click(target, 'Reload file');
	await until(() => word.row?.status === 'invalid', 'the broken file');

	expect(field('Your note for lucid')).toBeUndefined();
	const source = field('File text for lucid');
	expect(source?.value).toBe(broken.replace(/\r\n/g, '\n'));
	expect(target.textContent).toContain('not a valid word');
	expect(button(target, 'Understand')).toBeUndefined();

	// Reload first finishes; its outgoing controls remain fenced until then.
	await until(() => !word.fenced, 'reload to finish');
	// Accepted at once, then written; the text stays in view once valid.
	type(source, (source?.value ?? '').replace('!book ', ''));
	expect(word.row?.status).toBe('valid');
	flushSync();
	expect(field('File text for lucid')).toBe(source);
	await until(() => word.save?.status === 'idle', 'the repair to save');
	expect(await context.file('lucid')).toBe(broken.replace('!book ', ''));

	click(target, 'Show note and stage');
	flushSync();
	const note = field('Your note for lucid');
	expect(note).toBeDefined();
	type(note, 'after the repair');
	await until(
		() => entries.entries[0]?.note === 'after the repair',
		'the note',
	);
	expect(await context.file('lucid')).toContain('"source": "Moby Dick"');
});

test('a repair field removed when the learner returned to the note stays inert after a new repair field appears', async () => {
	await using context = await setup(['lucid']);
	const { browser, field, target } = context;
	const broken = tagged((await context.file('lucid')) ?? '');
	browser.put(context.path('lucid'), broken);
	const word = await context.opened('lucid');
	expect(await word.reload()).toBeNull();
	flushSync();
	const first = field('File text for lucid');
	expect(first?.value).toBe(broken);

	// Repaired, back to the note, then the file breaks again and is reloaded.
	type(first, broken.replace('!book ', ''));
	await until(() => word.save?.status === 'idle', 'the repair');
	click(target, 'Show note and stage');
	browser.put(context.path('lucid'), broken);
	expect(await word.reload()).toBeNull();
	flushSync();
	const second = field('File text for lucid');
	expect(second).toBeDefined();
	expect(second).not.toBe(first);

	type(first, 'into the removed field');
	expect(word.repairText()).toBe(broken);
	expect(second?.value).toBe(broken);
	type(second, `${broken}more`);
	expect(word.repairText()).toBe(`${broken}more`);
});

test('after an unconfirmed delete that landed, Check again shows the file is gone, and Let it go removes the word without creating anything', async () => {
	await using context = await setup(['lucid'], {
		landDeletesUnconfirmed: true,
	});
	const { entries, folder, target } = context;
	const word = await context.opened('lucid');
	const path = context.path('lucid');

	click(target, 'Delete');
	await until(() => word.deletion !== undefined, 'the delete to go unanswered');
	expect(target.textContent).toContain('could not be confirmed');

	click(target, 'Check again');
	await until(() => word.missing, 'the file to be read as gone');
	expect(target.textContent).toContain('its file is now gone');
	click(target, 'Let it go');
	await until(() => entries.entries.length === 0, 'the word to be let go');
	expect(await fileText(folder, path)).toBeUndefined();
});

test('the focus list offers stages only while the word is a valid row, and its removed buttons press nothing', async () => {
	await using context = await setup(['lucid']);
	const { browser, entries, byText } = context;
	const entry = byText('lucid');
	const word = await context.opened('lucid');
	const { default: FocusWords } = await import('./FocusWords.svelte');
	const target = document.createElement('div');
	document.body.append(target);
	const list = mount(FocusWords, {
		target,
		props: { focus: [{ entryId: entry.id, text: entry.text }], entries },
	});
	flushSync();
	const stages = () =>
		[...target.querySelectorAll('button')].map((element) => element.disabled);
	expect(stages()).toEqual([false, false, false, false]);

	const original = (await context.file('lucid')) ?? '';
	browser.put(context.path('lucid'), tagged(original));
	expect(await word.reload()).toBeNull();
	flushSync();
	expect(word.row?.status).toBe('invalid');
	expect(stages()).toEqual([true, true, true, true]);

	browser.put(context.path('lucid'), original);
	expect(await word.reload()).toBeNull();
	flushSync();
	expect(stages()).toEqual([false, false, false, false]);
	const use = button(target, 'Use');
	void unmount(list);
	target.remove();
	// The word is still kept by the list; a removed button reaches nothing.
	if (use === undefined) throw new Error('No Use button');
	click(target, use);
	await Bun.sleep(10);
	expect(word.save?.status).toBe('idle');
	expect(await context.file('lucid')).toBe(original);
});
