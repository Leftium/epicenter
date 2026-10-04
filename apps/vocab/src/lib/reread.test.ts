/**
 * Reread tests.
 * The real words list, chat list, and word editor run over Vocab's real
 * browser folder on an in-memory OPFS stand-in, with one listing held, or a save started
 * before more typing, so the order of a read and a receipt is fixed.
 *
 * Key behaviors:
 * - A listing made stale by this tab's own save is read again, so another
 *   tab's word or chat that it held is not lost
 * - Requests made while a read is out are answered by one more read, not one
 *   each, and none is dropped
 * - A note saved while typing goes on is what the word is then dirty
 *   against, so the learner's own save is never shown as a conflict
 * - A note another tab saved while typing, once read here, waits for the
 *   learner's choice; leaving the field does not save over it
 */
import './svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import { createBrowser, editWord, gated } from './folder.test-support.js';

const { createEntriesState } = await import('./entries.svelte.js');
const { createChatsState } = await import('./chat/chats.svelte.js');

const texts = (state: { entries: readonly { text: string }[] }) =>
	state.entries.map((entry) => entry.text).sort();

test('a words listing made stale by this tab’s own save is read again and keeps the other tab’s word', async () => {
	await using browser = createBrowser();
	const folder = await browser.open();
	const { gate, table } = gated(folder.tables.entries);
	const entries = createEntriesState({ table });
	await entries.refresh();
	const otherTab = createEntriesState({
		table: (await browser.open()).tables.entries,
	});

	// The other tab adds a word. Its hint starts a read here, which lists the
	// folder now and is delivered only after this tab's own save has landed.
	expectOk(await otherTab.add('nuance'));
	const delivery = Promise.withResolvers<void>();
	gate.heldListing = delivery.promise;
	const reading = entries.refresh();
	gate.heldListing = undefined;
	await Bun.sleep(5);
	expectOk(await entries.add('candid'));
	expect(texts(entries)).toEqual(['candid']);

	delivery.resolve();
	await reading;
	// The held listing lacked this tab's word, so it was not shown as is; the
	// folder was read again and both words are listed.
	expect(texts(entries)).toEqual(['candid', 'nuance']);
	expect(gate.lists).toBe(3);
});

test('requests made while a read is out are answered by one more read', async () => {
	await using browser = createBrowser();
	const folder = await browser.open();
	const { gate, table } = gated(folder.tables.entries);
	const entries = createEntriesState({ table });
	const otherTab = createEntriesState({
		table: (await browser.open()).tables.entries,
	});

	// A read lists the empty folder and is held. A word is saved elsewhere and
	// three hints arrive before the held listing is delivered.
	const delivery = Promise.withResolvers<void>();
	gate.heldListing = delivery.promise;
	const first = entries.refresh();
	gate.heldListing = undefined;
	await Bun.sleep(5);
	expectOk(await otherTab.add('lucid'));
	const hints = [entries.refresh(), entries.refresh(), entries.refresh()];

	delivery.resolve();
	await Promise.all([first, ...hints]);
	expect(texts(entries)).toEqual(['lucid']);
	expect(gate.lists).toBe(2);
});

test('a chat listing made stale by this tab’s new chat is read again and keeps the other tab’s chat', async () => {
	await using browser = createBrowser();
	const folder = await browser.open();
	const { gate, table } = gated(folder.tables.chats);
	const chats = createChatsState({
		tables: { chats: table, messages: folder.tables.messages },
	});
	await chats.refresh();
	const otherTab = createChatsState({ tables: (await browser.open()).tables });

	const theirs = expectOk(
		await otherTab.start([{ entryId: 'a', text: 'nuance' }]),
	);
	const delivery = Promise.withResolvers<void>();
	gate.heldListing = delivery.promise;
	const reading = chats.refresh();
	gate.heldListing = undefined;
	await Bun.sleep(5);
	const mine = expectOk(await chats.start([{ entryId: 'b', text: 'candid' }]));
	expect(chats.chats.map((chat) => chat.id)).toEqual([mine.id]);

	delivery.resolve();
	await reading;
	expect(chats.chats.map((chat) => chat.id).sort()).toEqual(
		[mine.id, theirs.id].sort(),
	);
});

// ============================================================================
// A note while it is typed
// ============================================================================

/** One word, its editor as the card has it, and another tab on the same folder. */
async function noteSetup() {
	const browser = createBrowser();
	const folder = await browser.open();
	const entries = createEntriesState({ table: folder.tables.entries });
	expectOk(await entries.add('candid'));
	const id = entries.entries[0]?.id ?? '';
	const word = entries.word(id);
	await word.open();
	const otherTab = createEntriesState({
		table: (await browser.open()).tables.entries,
	});
	await otherTab.refresh();
	return {
		entries,
		id,
		word,
		otherTab,
		saved: () => entries.entries[0]?.note,
		/** The note a fresh read of the folder finds. */
		async inFolder() {
			await otherTab.refresh();
			return otherTab.entries[0]?.note;
		},
		[Symbol.asyncDispose]: () => browser[Symbol.asyncDispose](),
	};
}

test('a note saved while typing goes on is what the word is then dirty against, not a conflict', async () => {
	await using context = await noteSetup();
	const { word } = context;

	// Type, leave the field, and type more before the save lands.
	word.inputNote('a');
	const first = word.blur();
	word.inputNote('ab');
	expect(await first).toBeNull();
	expect(context.saved()).toBe('a');
	expect(word.note('')).toBe('ab');
	expect(word.review).toBeUndefined();
	expect(word.unsettled).toBe(true);

	// Leaving again saves over the learner's own earlier save.
	expect(await word.blur()).toBeNull();
	expect(word.review).toBeUndefined();
	expect(context.saved()).toBe('ab');
	expect(await context.inFolder()).toBe('ab');
	expect(word.unsettled).toBe(false);
});

test('leaving the field again before the first save lands waits for it and is not a conflict either', async () => {
	await using context = await noteSetup();
	const { word } = context;

	word.inputNote('a');
	const first = word.blur();
	word.inputNote('ab');
	const second = word.blur();
	expect(await first).toBeNull();
	expect(await second).toBeNull();
	expect(word.review).toBeUndefined();
	expect(context.saved()).toBe('ab');
	expect(await context.inFolder()).toBe('ab');
});

test('a note another tab saved while typing, once read here, waits for a choice, and saving mine replaces it', async () => {
	await using context = await noteSetup();
	const { word, entries, otherTab, id } = context;

	word.inputNote('mine');
	expect(await editWord(otherTab, id, { note: 'theirs' })).toBeNull();
	// The other tab's hint is read here before the field is left.
	await entries.refresh();
	expect(await word.blur()).toBeNull();
	const review = word.review;
	expect(review?.kind === 'changed' && review.note).toBe('theirs');
	expect(word.note('')).toBe('mine');
	expect(await context.inFolder()).toBe('theirs');

	// Leaving the field again does not save over it by itself.
	expect(await word.blur()).toBeNull();
	expect(await context.inFolder()).toBe('theirs');

	expect(await word.saveMine()).toBeNull();
	expect(word.review).toBeUndefined();
	expect(await context.inFolder()).toBe('mine');
	expect(context.saved()).toBe('mine');
});
