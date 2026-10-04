/**
 * Saved chat tests.
 * The real message store, chat list, and tutor loop run over Vocab's real
 * browser folder on an in-memory OPFS stand-in. A message counts as saved once its file
 * exists, so "saved" is read back from the files and from the folder opened
 * again.
 *
 * Key behaviors:
 * - A message write resolves only after its file exists, and chats stay
 *   apart across reopening
 * - Saving a message again adds no second file, and a different message at
 *   its name is refused, not overwritten
 * - A new chat is its focus file: listed before any answer, and refused
 *   without one to three expressions
 * - Earlier, message-only chats are listed by their first learner question
 * - A message file that cannot be read is reported, never dropped silently
 * - A refused or closed folder fails the write and the tutor is not asked
 */
import '../svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import {
	type AgentEngine,
	type AgentMessage,
	createConversation,
} from '@epicenter/agent';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { readChat, readMessage, readRows, type VocabFolder } from '../data.js';
import {
	createBrowser,
	fileText,
	gated,
	tableFiles,
} from '../folder.test-support.js';
import { createChatMessageStore, listChats, startChat } from './messages.js';

const { createChatsState } = await import('./chats.svelte.js');

const question: AgentMessage = {
	id: 'question',
	role: 'user',
	createdAt: 1,
	parts: [{ type: 'text', text: 'What does "lucid" mean?' }],
};
const answer: AgentMessage = {
	id: 'answer',
	role: 'assistant',
	createdAt: 2,
	parts: [{ type: 'text', text: 'Clear and easy to understand: 清楚。' }],
};
const nextQuestion: AgentMessage = {
	id: 'next-question',
	role: 'user',
	createdAt: 3,
	parts: [{ type: 'text', text: 'How do I use "subtle"?' }],
};

async function setup() {
	const browser = createBrowser();
	return {
		browser,
		folder: await browser.open(),
		[Symbol.asyncDispose]: () => browser[Symbol.asyncDispose](),
	};
}

/** One chat's messages as a store opened over this folder reads them. */
async function transcript(folder: VocabFolder, chatId: string) {
	const store = createChatMessageStore(folder.tables.messages, chatId);
	expectOk(await store.load());
	return [...store.entries()]
		.map(({ val }) => val)
		.sort((a, b) => a.createdAt - b.createdAt);
}

/** Every chat as the folder's files list them. */
async function listed(folder: VocabFolder) {
	const chats = readRows(expectOk(await folder.tables.chats.list()), readChat);
	const messages = readRows(
		expectOk(await folder.tables.messages.list()),
		readMessage,
	);
	return listChats(chats.rows, messages.rows);
}

test('a message write resolves only after its file exists, and chats stay apart across reopening', async () => {
	await using context = await setup();
	const { browser, folder } = context;
	const first = createChatMessageStore(folder.tables.messages, 'chat-a');
	const second = createChatMessageStore(folder.tables.messages, 'chat-b');

	const writing = first.set(question.id, question);
	// Not in the transcript on the request alone.
	expect([...first.entries()]).toEqual([]);
	expectOk(await writing);
	expect([...first.entries()]).toEqual([{ key: question.id, val: question }]);
	expect(await tableFiles(folder, 'messages')).toEqual([
		'messages/question.md',
	]);

	expectOk(await first.set(answer.id, answer));
	expectOk(await second.set(nextQuestion.id, nextQuestion));

	const reopened = await browser.open();
	expect(await transcript(reopened, 'chat-a')).toEqual([question, answer]);
	expect(await transcript(reopened, 'chat-b')).toEqual([nextQuestion]);
	expect(await transcript(reopened, 'chat-c')).toEqual([]);
});

test('a message with line and paragraph separators, NEL, and C1 controls reads back exactly and is recognized on a second save', async () => {
	await using context = await setup();
	const { browser, folder } = context;
	// Characters YAML treats as line breaks or must escape, and JSON leaves raw.
	const c1 = Array.from({ length: 32 }, (_, index) =>
		String.fromCharCode(0x80 + index),
	).join('');
	const text = `one\u0085two three four ${c1} tab\tend ﻿`;
	const tricky: AgentMessage = {
		id: 'tricky',
		role: 'assistant',
		createdAt: 5,
		parts: [
			{ type: 'text', text },
			{ type: 'text', text: ' ' },
		],
	};
	const store = createChatMessageStore(folder.tables.messages, 'chat-a');
	expectOk(await store.set(tricky.id, tricky));

	const [read] = await transcript(await browser.open(), 'chat-a');
	expect(read).toEqual(tricky);
	const part = read?.parts[0];
	expect(part?.type === 'text' ? [...part.text] : []).toEqual([...text]);
	// The retry of an unconfirmed save compares against the file: it must
	// find its own message, not report a different one.
	const again = createChatMessageStore(folder.tables.messages, 'chat-a');
	expectOk(await again.set(tricky.id, tricky));
	expect(await tableFiles(folder, 'messages')).toEqual(['messages/tricky.md']);
});

test('saving a message again adds no second file, and a different message at its name is refused', async () => {
	await using context = await setup();
	const { folder } = context;
	const store = createChatMessageStore(folder.tables.messages, 'chat-a');
	expectOk(await store.set(answer.id, answer));
	const saved = await fileText(folder, 'messages/answer.md');

	// The retry after an unconfirmed attempt: the same message, the same file.
	const again = createChatMessageStore(folder.tables.messages, 'chat-a');
	expectOk(await again.set(answer.id, answer));
	expect(await tableFiles(folder, 'messages')).toEqual(['messages/answer.md']);
	expect(await fileText(folder, 'messages/answer.md')).toBe(saved);

	const other = {
		...answer,
		parts: [{ type: 'text' as const, text: 'Other' }],
	};
	expect(expectErr(await again.set(answer.id, other))).toMatchObject({
		name: 'WriteFailed',
		cause: { name: 'Taken' },
	});
	// The same message in another chat is not this chat's message either.
	const elsewhere = createChatMessageStore(folder.tables.messages, 'chat-b');
	expectErr(await elsewhere.set(answer.id, answer));
	expect(await fileText(folder, 'messages/answer.md')).toBe(saved);
	expect(await transcript(folder, 'chat-b')).toEqual([]);
});

test('a new chat is its focus file: listed before any answer, there after reopening, and it keeps the expression text', async () => {
	await using context = await setup();
	const { browser, folder } = context;
	const chats = createChatsState({ tables: folder.tables });
	await chats.refresh();

	const starting = chats.start([
		{ entryId: 'deleted-entry', text: '顺便 lucid' },
	]);
	expect(chats.chats).toEqual([]);
	const chat = expectOk(await starting);
	const expected = [
		{
			id: chat.id,
			title: '顺便 lucid',
			focus: [{ entryId: 'deleted-entry', text: '顺便 lucid' }],
			legacy: false,
		},
	];
	expect(chats.chats).toMatchObject(expected);
	expect(await tableFiles(folder, 'chats')).toEqual([`chats/${chat.id}.md`]);

	const reopened = createChatsState({ tables: (await browser.open()).tables });
	await reopened.refresh();
	expect(reopened.chats).toMatchObject(expected);
});

test('focus requires one to three expressions, and a refused focus writes nothing', async () => {
	await using context = await setup();
	const { folder } = context;
	expect(expectErr(await startChat(folder.tables.chats, [])).name).toBe(
		'InvalidFocus',
	);
	expect(
		expectErr(
			await startChat(
				folder.tables.chats,
				Array.from({ length: 4 }, (_, index) => ({
					entryId: String(index),
					text: 'word',
				})),
			),
		).name,
	).toBe('InvalidFocus');
	expect(await tableFiles(folder, 'chats')).toEqual([]);
});

test('a chat the folder refuses is not listed, and a closed folder reports that it cannot list', async () => {
	await using context = await setup();
	const { folder } = context;
	const { gate, table } = gated(folder.tables.chats);
	const chats = createChatsState({
		tables: { chats: table, messages: folder.tables.messages },
	});
	await chats.refresh();

	gate.failing = true;
	expect(
		expectErr(await chats.start([{ entryId: 'entry', text: 'lucid' }])).name,
	).toBe('NotSaved');
	expect(chats.chats).toEqual([]);
	expect(await tableFiles(folder, 'chats')).toEqual([]);

	gate.failing = false;
	await folder.close();
	expect(
		expectErr(await chats.start([{ entryId: 'entry', text: 'lucid' }])).name,
	).toBe('NotSaved');
	await chats.refresh();
	expect(chats.loadError).not.toBeNull();
});

test('chats are ordered by latest activity, and an earlier message-only chat is titled by its first question', async () => {
	await using context = await setup();
	const { folder } = context;
	const focused = expectOk(
		await startChat(folder.tables.chats, [{ entryId: 'entry', text: 'lucid' }]),
	);
	const old = createChatMessageStore(folder.tables.messages, 'old-chat');
	// Saved out of order: the title is still the earliest question.
	expectOk(
		await old.set('later', { ...nextQuestion, id: 'later', createdAt: 20 }),
	);
	expectOk(await old.set('earlier', { ...question, id: 'earlier' }));

	expect(
		(await listed(folder)).map(({ id, title, legacy, focus }) => ({
			id,
			title,
			legacy,
			focus,
		})),
	).toEqual([
		{
			id: focused.id,
			title: 'lucid',
			legacy: false,
			focus: [{ entryId: 'entry', text: 'lucid' }],
		},
		{
			id: 'old-chat',
			title: 'What does "lucid" mean?',
			legacy: true,
			focus: [],
		},
	]);
});

test('a message file that cannot be read is reported and left as it is, and two files with one message id show one message', async () => {
	await using context = await setup();
	const { folder } = context;
	const store = createChatMessageStore(folder.tables.messages, 'chat-a');
	expectOk(await store.set(question.id, question));
	// A second file holding the same message, as an import or another program can leave.
	expectOk(
		await folder.tables.messages.create({
			stem: 'zz-copy',
			fields: { chat: 'chat-a', message: question },
		}),
	);
	const wrongShape = '---\nchat: chat-a\nmessage:\n  id: broken\n---\n';
	const unparsed = 'not a row\n';
	expectOk(await folder.files.create('messages/wrong-shape.md', wrongShape));
	expectOk(await folder.files.create('messages/unparsed.md', unparsed));

	expectOk(await store.load());
	expect([...store.entries()]).toEqual([{ key: question.id, val: question }]);
	// The file that names this chat is this chat's to report.
	expect(store.unreadable.map((file) => file.path)).toEqual([
		'messages/wrong-shape.md',
	]);

	// The folder-wide list reports both, including the one that names no chat.
	const chats = createChatsState({ tables: folder.tables });
	await chats.refresh();
	expect(chats.unreadable.map((file) => file.path).sort()).toEqual([
		'messages/unparsed.md',
		'messages/wrong-shape.md',
	]);
	expect(await fileText(folder, 'messages/wrong-shape.md')).toBe(wrongShape);
	expect(await fileText(folder, 'messages/unparsed.md')).toBe(unparsed);
});

test('a closed folder fails the write and the read without rejecting', async () => {
	await using context = await setup();
	const { browser, folder } = context;
	const store = createChatMessageStore(folder.tables.messages, 'chat-a');
	expectOk(await store.set(question.id, question));
	await folder.close();

	expect(expectErr(await store.set(answer.id, answer)).name).toBe(
		'WriteFailed',
	);
	expect(expectErr(await store.load()).name).toBe('NotRead');
	// A failed read leaves what the store had; the file is as it was.
	expect([...store.entries()]).toEqual([{ key: question.id, val: question }]);
	expect(await transcript(await browser.open(), 'chat-a')).toEqual([question]);
});

test('a tutor conversation over a folder that refuses writes asks nothing, then keeps one file per message once it recovers', async () => {
	await using context = await setup();
	const { folder } = context;
	const { gate, table } = gated(folder.tables.messages);
	let calls = 0;
	const engine: AgentEngine = async function* () {
		calls++;
		// The folder stops taking writes while the tutor is answering.
		gate.failing = true;
		yield { type: 'text-delta', delta: 'Clear.' };
	};
	const conversation = createConversation({
		store: createChatMessageStore(table, 'chat-a'),
		engine,
		generateId: () => crypto.randomUUID(),
	});
	const settle = async () => {
		const isActive = () =>
			conversation.snapshot().isGenerating || conversation.snapshot().isSaving;
		for (let count = 0; count < 200 && isActive(); count++) await Bun.sleep(0);
	};
	const roles = () =>
		conversation.snapshot().messages.map((message) => message.role);

	gate.failing = true;
	expectErr(await conversation.send('What does "lucid" mean?'));
	await settle();
	expect(calls).toBe(0);
	expect(roles()).toEqual(['user']);
	expect(await tableFiles(folder, 'messages')).toEqual([]);

	gate.failing = false;
	expectOk(await conversation.save());
	expect(calls).toBe(0);
	expect(await tableFiles(folder, 'messages')).toHaveLength(1);

	conversation.retry();
	await settle();
	expect(calls).toBe(1);
	const unsavedAnswer = conversation.snapshot().unsaved;
	expect(unsavedAnswer.map((message) => message.role)).toEqual(['assistant']);
	expect(roles()).toEqual(['user', 'assistant']);
	expect(await tableFiles(folder, 'messages')).toHaveLength(1);

	gate.failing = false;
	expectOk(await conversation.save());
	expect(calls).toBe(1);
	expect(conversation.snapshot().unsaved).toEqual([]);
	expect(roles()).toEqual(['user', 'assistant']);
	expect(await transcript(folder, 'chat-a')).toEqual(
		conversation.snapshot().messages,
	);
	expect(conversation.snapshot().messages[1]).toEqual(unsavedAnswer[0]);
	conversation[Symbol.dispose]();
});

// ============================================================================
// Listings delivered late
// ============================================================================

test('a listing delivered after a newer message was saved does not remove that message, and the tutor is asked over it', async () => {
	await using context = await setup();
	const { folder } = context;
	const seeded = createChatMessageStore(folder.tables.messages, 'chat-a');
	expectOk(await seeded.set(answer.id, { ...answer, createdAt: 1 }));

	const { gate, table } = gated(folder.tables.messages);
	const store = createChatMessageStore(table, 'chat-a');
	expectOk(await store.load());
	const requests: number[] = [];
	const conversation = createConversation({
		store,
		engine: async function* (request) {
			requests.push(request.messages.length);
			yield { type: 'text-delta', delta: 'Yes.' };
		},
		generateId: () => crypto.randomUUID(),
	});
	const roles = () =>
		conversation.snapshot().messages.map((message) => message.role);

	// A listing is read now, holding only the first answer, and is delivered
	// after the learner's message has been saved and answered.
	const delivery = Promise.withResolvers<void>();
	gate.heldListing = delivery.promise;
	const stale = store.load();
	gate.heldListing = undefined;
	await Bun.sleep(5);

	expectOk(await conversation.send('Is "lucid" formal?'));
	const isActive = () =>
		conversation.snapshot().isGenerating || conversation.snapshot().isSaving;
	for (let count = 0; count < 200 && isActive(); count++) await Bun.sleep(0);
	expect(roles()).toEqual(['assistant', 'user', 'assistant']);
	expect([...store.entries()]).toHaveLength(3);

	delivery.resolve();
	expectOk(await stale);
	// The late listing knew neither new message. Both are still the transcript.
	expect(roles()).toEqual(['assistant', 'user', 'assistant']);
	expect([...store.entries()]).toHaveLength(3);
	// The tutor was asked over the saved learner message, once.
	expect(requests).toEqual([2]);
	expect(conversation.snapshot().unsaved).toEqual([]);
	expect(await transcript(folder, 'chat-a')).toEqual(
		conversation.snapshot().messages,
	);
	conversation[Symbol.dispose]();
});

test('an older listing delivered after a newer one does not replace it', async () => {
	await using context = await setup();
	const { folder } = context;
	const { gate, table } = gated(folder.tables.messages);
	const store = createChatMessageStore(table, 'chat-a');

	// The first load reads an empty chat and is delivered late.
	const delivery = Promise.withResolvers<void>();
	gate.heldListing = delivery.promise;
	const older = store.load();
	gate.heldListing = undefined;
	await Bun.sleep(5);

	// Another tab saves a message, and a second load reads it.
	const otherTab = createChatMessageStore(folder.tables.messages, 'chat-a');
	expectOk(await otherTab.set(question.id, question));
	expectOk(await store.load());
	expect([...store.entries()]).toEqual([{ key: question.id, val: question }]);

	delivery.resolve();
	expectOk(await older);
	expect([...store.entries()]).toEqual([{ key: question.id, val: question }]);
});
