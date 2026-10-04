/**
 * Earlier-Vocab import tests.
 * Rows are read from the real earlier store definitions, opened in memory,
 * and copied into Vocab's real browser folder on an in-memory OPFS stand-in.
 *
 * Key behaviors:
 * - Words, chats, and messages become files; a focus still names its word,
 *   and a message-only chat is listed without an invented focus
 * - Two earlier words with the same text are both kept, each with its own
 *   note and stage
 * - Importing again creates nothing and leaves a note or stage edited since
 *   exactly as the folder has it
 * - A run that stopped partway is completed by running it again
 * - A chat is not copied when its focus ID is held by a different word, and a
 *   message is not copied into a chat that is not its own: nothing joins
 *   another chat's transcript or controls another word's stage
 * - The earlier stores hold the same rows afterward
 */
import './svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import type { AgentMessage } from '@epicenter/agent';
import { InstantString } from '@epicenter/app/field';
import { openMemory } from '@epicenter/app/memory';
import { expectOk } from 'wellcrafted/testing';
import { createChatMessageStore, listChats } from './chat/messages.js';
import { focusWord, readChat, readMessage, readRows } from './data.js';
import {
	createBrowser,
	editWord,
	gated,
	tableFiles,
} from './folder.test-support.js';
import {
	importLegacy,
	legacyChatHistoryDefinition,
	legacyVocabDefinition,
} from './legacy-import.js';

const { createEntriesState } = await import('./entries.svelte.js');

const message = (
	id: string,
	role: AgentMessage['role'],
	createdAt: number,
	text: string,
): AgentMessage => ({
	id,
	role,
	createdAt,
	parts: [{ type: 'text', text }],
});

/** The earlier stores as one account left them, and an empty folder. */
async function setup() {
	const personal = await openMemory(legacyVocabDefinition);
	const local = await openMemory(legacyChatHistoryDefinition);
	const createdAt = InstantString.now();
	const lucid = personal.tables.entries.create({
		text: 'lucid',
		note: 'clear; 清楚',
		stage: 'understood',
		createdAt,
	});
	// The same text saved on two devices: two rows, two notes, two stages.
	personal.tables.entries.create({
		text: 'subtle',
		note: 'first device',
		stage: 'recognized',
		createdAt,
	});
	personal.tables.entries.create({
		text: 'subtle',
		note: 'second device',
		stage: 'usable',
		createdAt,
	});
	const chat = local.tables.chats.create({
		accountKey: 'account-a',
		createdAt,
		focus: [{ entryId: lucid.id, text: 'lucid' }],
	});
	for (const [conversationId, item] of [
		[chat.id, message('opening', 'assistant', 1, 'Welcome! Try "lucid".')],
		[chat.id, message('reply', 'user', 2, 'A lucid talk.')],
		// From before chats had a focus: messages with no chat row.
		[
			'old-chat',
			message('old-question', 'user', 3, 'What does "candid" mean?'),
		],
		['old-chat', message('old-answer', 'assistant', 4, 'Honest and direct.')],
	] as const)
		local.tables.messages.create({
			accountKey: 'account-a',
			conversationId,
			messageId: item.id,
			message: item,
		});

	const browser = createBrowser();
	const folder = await browser.open();
	const rows = () => ({
		entries: personal.tables.entries.ids().map((id) => personal.tables.entries.get(id)).filter((row) => row !== undefined),
		chats: local.tables.chats.ids().map((id) => local.tables.chats.get(id)).filter((row) => row !== undefined),
		messages: local.tables.messages.ids().map((id) => local.tables.messages.get(id)).filter((row) => row !== undefined),
	});
	return {
		folder,
		rows,
		lucidId: lucid.id,
		chatId: chat.id,
		async words() {
			const entries = createEntriesState({ table: folder.tables.entries });
			await entries.refresh();
			return entries;
		},
		async chats() {
			const chats = readRows(
				expectOk(await folder.tables.chats.list()),
				readChat,
			);
			const messages = readRows(
				expectOk(await folder.tables.messages.list()),
				readMessage,
			);
			expect([...chats.unreadable, ...messages.unreadable]).toEqual([]);
			return listChats(chats.rows, messages.rows);
		},
		async [Symbol.asyncDispose]() {
			await browser[Symbol.asyncDispose]();
			await personal[Symbol.asyncDispose]();
			await local[Symbol.asyncDispose]();
		},
	};
}

const summary = (state: {
	entries: readonly { text: string; note: string; stage: string }[];
}) =>
	state.entries
		.map(({ text, note, stage }) => ({ text, note, stage }))
		.sort((a, b) => a.note.localeCompare(b.note));

test('earlier words, chats, and messages become files, with focus links, duplicate words, and message-only chats kept', async () => {
	await using context = await setup();
	const before = JSON.stringify(context.rows());

	const report = await importLegacy(context.folder.tables, context.rows());
	expect(report).toEqual({
		words: { copied: 3, alreadyHere: 0, failed: [] },
		chats: { copied: 1, alreadyHere: 0, failed: [] },
		messages: { copied: 4, alreadyHere: 0, failed: [] },
	});

	const words = await context.words();
	expect(summary(words)).toEqual([
		{ text: 'lucid', note: 'clear; 清楚', stage: 'understood' },
		{ text: 'subtle', note: 'first device', stage: 'recognized' },
		{ text: 'subtle', note: 'second device', stage: 'usable' },
	]);
	// The chat's focus names the imported word by the same ID.
	expect(
		words.entries.find((entry) => entry.id === context.lucidId)?.text,
	).toBe('lucid');
	expect(
		(await context.chats()).map(({ id, title, legacy, focus }) => ({
			id,
			title,
			legacy,
			focus,
		})),
	).toEqual([
		{
			id: context.chatId,
			title: 'lucid',
			legacy: false,
			focus: [{ entryId: context.lucidId, text: 'lucid' }],
		},
		{
			id: 'old-chat',
			title: 'What does "candid" mean?',
			legacy: true,
			focus: [],
		},
	]);

	// The earlier stores are read, never written.
	expect(JSON.stringify(context.rows())).toBe(before);
});

test('importing again creates nothing and leaves a note and stage edited since as the folder has them', async () => {
	await using context = await setup();
	await importLegacy(context.folder.tables, context.rows());
	const words = await context.words();
	expect(
		await editWord(words, context.lucidId, {
			note: 'clear and easy to follow',
			stage: 'usable',
		}),
	).toBeNull();
	const files = await tableFiles(context.folder, 'entries');

	const again = await importLegacy(context.folder.tables, context.rows());
	expect(again).toEqual({
		words: { copied: 0, alreadyHere: 3, failed: [] },
		chats: { copied: 0, alreadyHere: 1, failed: [] },
		messages: { copied: 0, alreadyHere: 4, failed: [] },
	});
	expect(await tableFiles(context.folder, 'entries')).toEqual(files);
	expect(summary(await context.words())).toContainEqual({
		text: 'lucid',
		note: 'clear and easy to follow',
		stage: 'usable',
	});
});

test('a run that the folder stopped partway reports what was not copied and is completed by running again', async () => {
	await using context = await setup();
	const { gate, table } = gated(context.folder.tables.messages);
	gate.failing = true;

	const partial = await importLegacy(
		{ ...context.folder.tables, messages: table },
		context.rows(),
	);
	expect(partial.words).toEqual({ copied: 3, alreadyHere: 0, failed: [] });
	expect(partial.messages.copied).toBe(0);
	expect(partial.messages.failed).toHaveLength(4);
	expect(await tableFiles(context.folder, 'messages')).toEqual([]);

	gate.failing = false;
	const completed = await importLegacy(
		{ ...context.folder.tables, messages: table },
		context.rows(),
	);
	expect(completed).toEqual({
		words: { copied: 0, alreadyHere: 3, failed: [] },
		chats: { copied: 0, alreadyHere: 1, failed: [] },
		messages: { copied: 4, alreadyHere: 0, failed: [] },
	});
	expect(await tableFiles(context.folder, 'messages')).toHaveLength(4);
});

test('an earlier message that is not a whole message is reported and nothing is written for it', async () => {
	await using context = await setup();
	const rows = context.rows();
	const broken = {
		...rows.messages[0],
		id: 'broken-row',
		message: { id: 'broken', role: 'tutor' },
	} as (typeof rows.messages)[number];

	const report = await importLegacy(context.folder.tables, {
		...rows,
		messages: [...rows.messages, broken],
	});
	expect(report.messages.copied).toBe(4);
	expect(report.messages.failed.map((item) => item.id)).toEqual(['broken-row']);
	expect(await tableFiles(context.folder, 'messages')).toHaveLength(4);
});

test('a different word already at an earlier row’s file name is not taken for its copy: it is reported and keeps its note and stage', async () => {
	await using context = await setup();
	const { folder, lucidId } = context;
	// A file with the earlier row's name that is not that row.
	const other = expectOk(
		await folder.tables.entries.create({
			stem: lucidId,
			fields: {
				text: 'lurid',
				note: 'the learner’s own note',
				stage: 'usable',
				createdAt: InstantString.now(),
			},
		}),
	);

	const report = await importLegacy(folder.tables, context.rows());
	expect(report.words.copied).toBe(2);
	expect(report.words.alreadyHere).toBe(0);
	expect(report.words.failed.map((item) => item.id)).toEqual([lucidId]);
	expect(expectOk(await folder.tables.entries.get(lucidId))?.source).toBe(
		other.source,
	);

	// Running again reports the same row again instead of counting it as copied.
	const again = await importLegacy(folder.tables, context.rows());
	expect(again.words).toMatchObject({ copied: 0, alreadyHere: 2 });
	expect(again.words.failed.map((item) => item.id)).toEqual([lucidId]);
});

// ============================================================================
// What a copied row refers to
// ============================================================================

/** The message IDs one chat's transcript holds, as an opened chat reads them. */
async function transcriptOf(
	context: Awaited<ReturnType<typeof setup>>,
	chatId: string,
) {
	const store = createChatMessageStore(context.folder.tables.messages, chatId);
	expectOk(await store.load());
	return [...store.entries()].map(({ key }) => key).sort();
}

const otherWord = {
	text: 'lurid',
	note: 'the learner’s own note',
	stage: 'usable',
} as const;

test('a chat whose focus ID is held by a different word is not copied, nor are its messages, until that word is gone', async () => {
	await using context = await setup();
	const { folder, lucidId, chatId } = context;
	expectOk(
		await folder.tables.entries.create({
			stem: lucidId,
			fields: { ...otherWord, createdAt: InstantString.now() },
		}),
	);

	const report = await importLegacy(folder.tables, context.rows());
	expect(report.chats.copied).toBe(0);
	expect(report.chats.failed.map((item) => item.id)).toEqual([chatId]);
	// Only the message-only chat's two messages were copied.
	expect(report.messages.copied).toBe(2);
	expect(report.messages.failed).toHaveLength(2);
	expect(await tableFiles(folder, 'chats')).toEqual([]);
	expect(await transcriptOf(context, chatId)).toEqual([]);
	expect((await context.chats()).map((chat) => chat.id)).toEqual(['old-chat']);
	// No focus anywhere can reach the other word, which is as the learner left it.
	expect(summary(await context.words())).toContainEqual(otherWord);

	// The learner removes the other word. Importing again copies what waited.
	const words = await context.words();
	expectOk(await words.remove(lucidId));
	const again = await importLegacy(folder.tables, context.rows());
	expect(again).toEqual({
		words: { copied: 1, alreadyHere: 2, failed: [] },
		chats: { copied: 1, alreadyHere: 0, failed: [] },
		messages: { copied: 2, alreadyHere: 2, failed: [] },
	});
	expect(await transcriptOf(context, chatId)).toEqual(['opening', 'reply']);
	const [chat] = (await context.chats()).filter((item) => item.id === chatId);
	const focus = chat?.focus[0];
	if (!focus) throw new Error('the chat was not copied');
	// The focus control acts on the word the focus was chosen from.
	expect(focusWord((await context.words()).entries, focus)).toMatchObject({
		id: lucidId,
		text: 'lucid',
		note: 'clear; 清楚',
		stage: 'understood',
	});
});

test('a focus never controls a word with another text, even if a chat names its ID', async () => {
	await using context = await setup();
	const { folder, lucidId } = context;
	expectOk(
		await folder.tables.entries.create({
			stem: lucidId,
			fields: { ...otherWord, createdAt: InstantString.now() },
		}),
	);
	const { entries } = await context.words();
	expect(
		focusWord(entries, { entryId: lucidId, text: 'lucid' }),
	).toBeUndefined();
	expect(focusWord(entries, { entryId: lucidId, text: 'lurid' })?.id).toBe(
		lucidId,
	);
});

test('messages of a chat whose ID is held by a different chat do not join that chat', async () => {
	await using context = await setup();
	const { folder, chatId } = context;
	// A chat of the folder's own at the earlier chat's ID, with its own message.
	expectOk(
		await folder.tables.chats.create({
			stem: chatId,
			fields: {
				createdAt: InstantString.now(),
				focus: [{ entryId: 'other-entry', text: 'candid' }],
			},
		}),
	);
	const own = createChatMessageStore(folder.tables.messages, chatId);
	expectOk(await own.set('own', message('own', 'assistant', 9, 'Hello.')));

	const report = await importLegacy(folder.tables, context.rows());
	expect(report.chats.failed.map((item) => item.id)).toEqual([chatId]);
	expect(report.messages.copied).toBe(2);
	expect(report.messages.failed).toHaveLength(2);
	// The folder's chat has exactly the transcript and focus it had.
	expect(await transcriptOf(context, chatId)).toEqual(['own']);
	expect(
		(await context.chats()).find((chat) => chat.id === chatId)?.focus,
	).toEqual([{ entryId: 'other-entry', text: 'candid' }]);

	// Running again refuses the same rows again.
	const again = await importLegacy(folder.tables, context.rows());
	expect(again.messages).toMatchObject({ copied: 0, alreadyHere: 2 });
	expect(again.messages.failed).toHaveLength(2);
	expect(await transcriptOf(context, chatId)).toEqual(['own']);
});

test('messages with no chat row do not join a chat that already has their conversation ID', async () => {
	await using context = await setup();
	const { folder, chatId } = context;
	expectOk(
		await folder.tables.chats.create({
			stem: 'old-chat',
			fields: {
				createdAt: InstantString.now(),
				focus: [{ entryId: 'other-entry', text: 'candid' }],
			},
		}),
	);

	const report = await importLegacy(folder.tables, context.rows());
	expect(report.chats).toEqual({ copied: 1, alreadyHere: 0, failed: [] });
	expect(report.messages.copied).toBe(2);
	expect(report.messages.failed).toHaveLength(2);
	expect(await transcriptOf(context, 'old-chat')).toEqual([]);
	expect(await transcriptOf(context, chatId)).toEqual(['opening', 'reply']);
	expect(
		(await context.chats()).find((chat) => chat.id === 'old-chat'),
	).toMatchObject({ title: 'candid', legacy: false });
});

test('messages wait for a chat the folder could not save, and are copied once it is', async () => {
	await using context = await setup();
	const { folder, chatId } = context;
	const { gate, table } = gated(folder.tables.chats);
	const tables = { ...folder.tables, chats: table };

	gate.failing = true;
	const partial = await importLegacy(tables, context.rows());
	expect(partial.chats.failed.map((item) => item.id)).toEqual([chatId]);
	expect(partial.messages.copied).toBe(2);
	expect(partial.messages.failed).toHaveLength(2);
	// Its messages did not become a chat of their own in the meantime.
	expect((await context.chats()).map((chat) => chat.id)).toEqual(['old-chat']);

	gate.failing = false;
	const completed = await importLegacy(tables, context.rows());
	expect(completed.chats).toEqual({ copied: 1, alreadyHere: 0, failed: [] });
	expect(completed.messages).toEqual({ copied: 2, alreadyHere: 2, failed: [] });
	expect(await transcriptOf(context, chatId)).toEqual(['opening', 'reply']);
});
