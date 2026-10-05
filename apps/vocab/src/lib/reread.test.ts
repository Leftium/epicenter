/**
 * Reread tests.
 * The real words list, chat list, and word editor run over Vocab's real
 * browser folder on an in-memory OPFS stand-in, with one listing held so the
 * order of a read and a receipt is fixed.
 *
 * Key behaviors:
 * - A listing made stale by this tab's own save is read again, so another
 *   tab's word or chat that it held is not lost
 * - Requests made while a read is out are answered by one more read, not one
 *   each, and none is dropped
 * - The list follows the latest note once the saves made while typing land
 */
import './svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import {
	createBrowser,
	entriesOf,
	gated,
	until,
} from './folder.test-support.js';

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
	const otherTab = createEntriesState(entriesOf(await browser.open()));

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
	const otherTab = createEntriesState(entriesOf(await browser.open()));

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

test('the list follows the latest note once the saves made while typing land', async () => {
	await using browser = createBrowser();
	const entries = createEntriesState(entriesOf(await browser.open()));
	expectOk(await entries.add('candid'));
	const id = entries.entries[0]?.id ?? '';
	const word = entries.word(id);
	await word.open();
	const listed = () => entries.entries[0]?.note;

	word.inputNote('a');
	await until(() => listed() === 'a', 'the first note to be listed');
	word.inputNote('ab');
	word.inputNote('abc');
	await until(
		() => listed() === 'abc' && word.save?.status === 'idle',
		'the latest note to be listed',
	);
	expect(word.unsettled).toBe(false);
	const again = createEntriesState(entriesOf(await browser.open()));
	await again.refresh();
	expect(again.entries.map((entry) => entry.note)).toEqual(['abc']);
});
