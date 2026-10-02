/**
 * Saved chat tests.
 * Real memory stores preserve conversation and account isolation across reopen,
 * deduplicate message identities, and derive stable titles and focused chats.
 *
 * A message counts as saved only once this device's storage holds it. The
 * storage tests run the real persistence queue over a SQLite record that can
 * refuse commits, so "saved" is read back from the record, never assumed from
 * the table write.
 */
import { expect, test } from 'bun:test';
import {
	type AgentEngine,
	type AgentMessage,
	createConversation,
} from '@epicenter/agent';
import { createMemoryRecord, openMemory } from '@epicenter/app/memory';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { chatHistoryDefinition } from '../data.js';
import {
	createChatMessageStore,
	listChats,
	saveChatHistory,
	startChat,
} from './messages.js';

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
	parts: [{ type: 'text', text: 'Clear and easy to understand.' }],
};
const nextQuestion: AgentMessage = {
	id: 'next-question',
	role: 'user',
	createdAt: 3,
	parts: [{ type: 'text', text: 'How do I use "subtle"?' }],
};

/**
 * A durable record whose commits can be refused whole, the way a full or
 * revoked browser store refuses them. `savedMessages` reopens the record, so
 * it reports what a restart would find.
 */
function failableRecord() {
	const inner = createMemoryRecord();
	const gate = { failing: false };
	const record = {
		close: inner.close,
		sqlite: {
			run: inner.sqlite.run.bind(inner.sqlite),
			all: inner.sqlite.all.bind(inner.sqlite),
			transaction<TResult>(run: () => TResult): TResult {
				if (gate.failing) throw new Error('storage refused the commit');
				return inner.sqlite.transaction(run);
			},
		} as typeof inner.sqlite,
	};
	return {
		record,
		gate,
		/** Committed document updates, read synchronously from the record. */
		committedUpdates: () =>
			inner.sqlite.all<{ count: number }>(
				'SELECT COUNT(*) AS count FROM _updates',
			)[0]?.count ?? 0,
		async savedMessages() {
			await using reopened = await openMemory(chatHistoryDefinition, inner);
			return reopened.tables.messages.rows.map((row) => row.messageId).sort();
		},
	};
}

test('saved chats survive reopening and stay within their account and conversation', async () => {
	const record = createMemoryRecord();
	try {
		{
			await using db = await openMemory(chatHistoryDefinition, record);
			using first = createChatMessageStore(
				db.tables.messages,
				db.persistence,
				'account-a',
				'chat-a',
			);
			using second = createChatMessageStore(
				db.tables.messages,
				db.persistence,
				'account-a',
				'chat-b',
			);
			using otherAccount = createChatMessageStore(
				db.tables.messages,
				db.persistence,
				'account-b',
				'chat-a',
			);
			expectOk(await first.set(question.id, question));
			expectOk(await first.set(answer.id, answer));
			expectOk(await second.set(nextQuestion.id, nextQuestion));
			expectOk(
				await otherAccount.set(question.id, {
					...question,
					parts: [{ type: 'text', text: 'Private' }],
				}),
			);
			expect(
				[...first.entries()]
					.map(({ val }) => val)
					.sort((a, b) => a.createdAt - b.createdAt),
			).toEqual([question, answer]);
			expect([...second.entries()].map(({ val }) => val)).toEqual([
				nextQuestion,
			]);
			expect(
				listChats(
					db.tables.chats.rows,
					db.tables.messages.rows,
					'account-a',
				).map(({ id, title }) => ({ id, title })),
			).toEqual([
				{ id: 'chat-b', title: 'How do I use "subtle"?' },
				{ id: 'chat-a', title: 'What does "lucid" mean?' },
			]);
		}

		await using db = await openMemory(chatHistoryDefinition, record);
		using first = createChatMessageStore(
			db.tables.messages,
			db.persistence,
			'account-a',
			'chat-a',
		);
		using second = createChatMessageStore(
			db.tables.messages,
			db.persistence,
			'account-a',
			'chat-b',
		);
		expect([...first.entries()]).toHaveLength(2);
		expect([...second.entries()]).toHaveLength(1);
		expect(
			listChats(db.tables.chats.rows, db.tables.messages.rows, 'account-b'),
		).toHaveLength(1);
		expect(
			listChats(db.tables.chats.rows, db.tables.messages.rows, 'account-a'),
		).toHaveLength(2);
	} finally {
		record.close();
	}
});

test('a legacy chat appears after its first message', async () => {
	await using db = await openMemory(chatHistoryDefinition);
	using chat = createChatMessageStore(
		db.tables.messages,
		db.persistence,
		'account-a',
		'new-chat',
	);
	expect([...chat.entries()]).toEqual([]);
	expect(
		listChats(db.tables.chats.rows, db.tables.messages.rows, 'account-a'),
	).toEqual([]);
	expectOk(await chat.set(question.id, question));
	expect(
		listChats(db.tables.chats.rows, db.tables.messages.rows, 'account-a')[0]
			?.id,
	).toBe('new-chat');
});

test('duplicate message rows present one stable value inside one conversation', async () => {
	await using db = await openMemory(chatHistoryDefinition);
	for (let index = 0; index < 2; index++) {
		db.tables.messages.create({
			accountKey: 'account-a',
			conversationId: 'chat-a',
			messageId: question.id,
			message: question,
		});
	}
	using chat = createChatMessageStore(
		db.tables.messages,
		db.persistence,
		'account-a',
		'chat-a',
	);
	expect([...chat.entries()]).toEqual([{ key: question.id, val: question }]);
});

test('a focused chat is listed before an answer, scoped to its account, and stores the expression text', async () => {
	await using db = await openMemory(chatHistoryDefinition);
	const chat = startChat(db.tables.chats, 'account-a', [
		{ entryId: 'deleted-entry', text: 'lucid' },
	]);
	expect(
		listChats(db.tables.chats.rows, db.tables.messages.rows, 'account-a'),
	).toMatchObject([
		{
			id: chat.id,
			title: 'lucid',
			focus: [{ entryId: 'deleted-entry', text: 'lucid' }],
		},
	]);
	expect(
		listChats(db.tables.chats.rows, db.tables.messages.rows, 'account-b'),
	).toEqual([]);
});

test('legacy title comes from the earliest question even when rows arrive out of order', async () => {
	await using db = await openMemory(chatHistoryDefinition);
	db.tables.messages.create({
		accountKey: 'account-a',
		conversationId: 'old-chat',
		messageId: 'later',
		message: { ...nextQuestion, createdAt: 20 },
	});
	db.tables.messages.create({
		accountKey: 'account-a',
		conversationId: 'old-chat',
		messageId: 'earlier',
		message: question,
	});
	expect(
		listChats(db.tables.chats.rows, db.tables.messages.rows, 'account-a')[0]
			?.title,
	).toBe('What does "lucid" mean?');
});

test('focus requires one to three expressions', async () => {
	await using db = await openMemory(chatHistoryDefinition);
	expect(() => startChat(db.tables.chats, 'account-a', [])).toThrow();
	expect(() =>
		startChat(
			db.tables.chats,
			'account-a',
			Array.from({ length: 4 }, (_, index) => ({
				entryId: String(index),
				text: 'word',
			})),
		),
	).toThrow();
});

// ============================================================================
// Storage confirmation
// ============================================================================

test('a message write resolves only after storage holds the message', async () => {
	const { record, committedUpdates, savedMessages } = failableRecord();
	try {
		await using db = await openMemory(chatHistoryDefinition, record);
		using chat = createChatMessageStore(
			db.tables.messages,
			db.persistence,
			'account-a',
			'chat-a',
		);
		const before = committedUpdates();
		const writing = chat.set(question.id, question);
		// Accepted into the live document at once, and not yet on the record.
		expect(db.tables.messages.rows).toHaveLength(1);
		expect(committedUpdates()).toBe(before);

		expectOk(await writing);
		expect(committedUpdates()).toBe(before + 1);
		expect(await savedMessages()).toEqual([question.id]);
	} finally {
		record.close();
	}
});

test('refused storage fails the write, and saving the accepted row again adds no second row', async () => {
	const { record, gate, savedMessages } = failableRecord();
	try {
		await using db = await openMemory(chatHistoryDefinition, record);
		using chat = createChatMessageStore(
			db.tables.messages,
			db.persistence,
			'account-a',
			'chat-a',
		);
		gate.failing = true;
		const failure = expectErr(await chat.set(question.id, question));
		expect(failure).toMatchObject({
			name: 'WriteFailed',
			cause: { name: 'NotSaved' },
		});
		expect(db.persistence.get()).toBe('blocked');
		expect(db.tables.messages.rows).toHaveLength(1);
		expect(await savedMessages()).toEqual([]);

		// Still refused: the retry reports the same failure and writes nothing new.
		expectErr(await chat.set(question.id, question));
		expect(db.tables.messages.rows).toHaveLength(1);

		gate.failing = false;
		expectOk(await chat.set(question.id, question));
		expect(db.tables.messages.rows).toHaveLength(1);
		expect([...chat.entries()]).toEqual([{ key: question.id, val: question }]);
		expect(await savedMessages()).toEqual([question.id]);
	} finally {
		record.close();
	}
});

test('a new chat focus is confirmed by storage before it counts as saved', async () => {
	const { record, gate } = failableRecord();
	try {
		await using db = await openMemory(chatHistoryDefinition, record);
		gate.failing = true;
		const chat = startChat(db.tables.chats, 'account-a', [
			{ entryId: 'entry', text: 'lucid' },
		]);
		expect(expectErr(await saveChatHistory(db.persistence)).name).toBe(
			'NotSaved',
		);
		// Unsaved, the chat is still listed for this session.
		expect(
			listChats(db.tables.chats.rows, db.tables.messages.rows, 'account-a'),
		).toMatchObject([{ id: chat.id }]);

		gate.failing = false;
		expectOk(await saveChatHistory(db.persistence));
		expect(db.persistence.get()).toBe('saved');
	} finally {
		record.close();
	}
});

test('a tutor conversation over refused storage asks nothing, then keeps one copy of each message once storage recovers', async () => {
	const { record, gate, savedMessages } = failableRecord();
	try {
		await using db = await openMemory(chatHistoryDefinition, record);
		let calls = 0;
		const engine: AgentEngine = async function* () {
			calls++;
			// Storage goes away while the tutor is answering.
			gate.failing = true;
			yield { type: 'text-delta', delta: 'Clear.' };
		};
		const conversation = createConversation({
			store: createChatMessageStore(
				db.tables.messages,
				db.persistence,
				'account-a',
				'chat-a',
			),
			engine,
			generateId: () => crypto.randomUUID(),
		});
		const settle = async () => {
			const isActive = () =>
				conversation.snapshot().isGenerating ||
				conversation.snapshot().isSaving;
			for (let count = 0; count < 200 && isActive(); count++) {
				await Bun.sleep(0);
			}
		};
		const roles = () =>
			conversation.snapshot().messages.map((message) => message.role);

		gate.failing = true;
		expectErr(await conversation.send('What does "lucid" mean?'));
		await settle();
		expect(calls).toBe(0);
		expect(roles()).toEqual(['user']);

		gate.failing = false;
		expectOk(await conversation.save());
		expect(calls).toBe(0);
		expect(await savedMessages()).toHaveLength(1);

		conversation.retry();
		await settle();
		expect(calls).toBe(1);
		const unsavedAnswer = conversation.snapshot().unsaved;
		expect(unsavedAnswer.map((message) => message.role)).toEqual(['assistant']);
		expect(roles()).toEqual(['user', 'assistant']);
		expect(await savedMessages()).toHaveLength(1);

		gate.failing = false;
		expectOk(await conversation.save());
		expect(calls).toBe(1);
		expect(conversation.snapshot().unsaved).toEqual([]);
		expect(roles()).toEqual(['user', 'assistant']);
		expect(db.tables.messages.rows).toHaveLength(2);
		expect(await savedMessages()).toEqual(
			conversation
				.snapshot()
				.messages.map((message) => message.id)
				.sort(),
		);
		expect(conversation.snapshot().messages[1]).toEqual(unsavedAnswer[0]);
		conversation[Symbol.dispose]();
	} finally {
		record.close();
	}
});
