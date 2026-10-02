/**
 * Vocab chat session tests.
 * The real session, loop, message store, and persistence queue run over a
 * SQLite record that can refuse commits, with the tutor behind an OpenAI client
 * whose requests are answered in-process and counted.
 *
 * Key behaviors:
 * - The draft stays until storage confirms the learner message, and typing
 *   that arrives meanwhile is never cleared
 * - Refused storage asks the tutor nothing; saving again asks nothing either
 * - No tutor turn starts over history that storage has not taken
 */
import { expect, test } from 'bun:test';
import type { AgentMessage } from '@epicenter/agent';
import { createMemoryRecord, openMemory } from '@epicenter/app/memory';
import OpenAI from 'openai';
import { chatHistoryDefinition } from '../data.js';
import { startChat } from './messages.js';

// Bun runs the rune modules uncompiled: state is a plain value, and a derived
// value is read through to its source on every access.
Reflect.set(globalThis, '$state', <T>(value: T) => value);
Reflect.set(globalThis, '$derived', {
	by: <T extends object>(read: () => T) =>
		new Proxy({} as T, { get: (_target, key) => Reflect.get(read(), key) }),
});
const { createVocabChat } = await import('./session.svelte.js');

type ChatOptions = Parameters<typeof createVocabChat>[0];

const welcome: AgentMessage = {
	id: 'welcome',
	role: 'assistant',
	createdAt: 1,
	parts: [{ type: 'text', text: 'Welcome! Try "lucid" in a sentence.' }],
};

/** One chat over storage that can refuse commits and a counted tutor. */
async function setup() {
	const inner = createMemoryRecord();
	const gate = { failing: false };
	const db = await openMemory(chatHistoryDefinition, {
		close: inner.close,
		sqlite: {
			run: inner.sqlite.run.bind(inner.sqlite),
			all: inner.sqlite.all.bind(inner.sqlite),
			transaction<TResult>(run: () => TResult): TResult {
				if (gate.failing) throw new Error('storage refused the commit');
				return inner.sqlite.transaction(run);
			},
		} as typeof inner.sqlite,
	});
	const tutor = { requests: 0, finishReason: 'stop' };
	const client = new OpenAI({
		apiKey: 'test',
		baseURL: 'https://tutor.test/v1',
		maxRetries: 0,
		fetch: async () => {
			tutor.requests += 1;
			const chunk = {
				choices: [
					{
						index: 0,
						delta: { content: 'Nice.' },
						finish_reason: tutor.finishReason,
					},
				],
			};
			return new Response(
				`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
				{ headers: { 'content-type': 'text/event-stream' } },
			);
		},
	});
	// The store's own persistence, with a flush a test can hold open the way a
	// slow browser store holds a commit.
	let held: PromiseWithResolvers<void> | undefined;
	const persistence: typeof db.persistence = {
		get: () => db.persistence.get(),
		subscribe: (listener) => db.persistence.subscribe(listener),
		async flush() {
			await held?.promise;
			await db.persistence.flush();
		},
	};
	const open = () =>
		createVocabChat({
			messages: db.tables.messages,
			persistence,
			accountKey: 'account-a',
			conversationId: 'chat-a',
			focus: [{ text: 'lucid' }],
			catalog: {
				accountId: 'account',
				ready: Promise.resolve(),
				resolve: () => ({ source: 'account', client, model: 'test-model' }),
			} as unknown as ChatOptions['catalog'],
			selections: {
				get: () => undefined,
				set: () => {},
				onChange: () => () => {},
			} as unknown as ChatOptions['selections'],
		});
	const seed = (message: AgentMessage) =>
		db.tables.messages.create({
			accountKey: 'account-a',
			conversationId: 'chat-a',
			messageId: message.id,
			message,
		});
	return {
		db,
		gate,
		tutor,
		open,
		seed,
		/** Hold every storage flush open until the returned gate resolves. */
		holdStorage() {
			held = Promise.withResolvers<void>();
			return held;
		},
		async [Symbol.asyncDispose]() {
			await db[Symbol.asyncDispose]();
			inner.close();
		},
	};
}

async function settle(chat: { isGenerating: boolean; isSaving: boolean }) {
	for (
		let count = 0;
		count < 200 && (chat.isGenerating || chat.isSaving);
		count++
	) {
		await Bun.sleep(0);
	}
}

const roles = (chat: { messages: AgentMessage[] }) =>
	chat.messages.map((message) => message.role);

test('the draft stays until storage confirms the learner message, then clears', async () => {
	await using context = await setup();
	context.seed(welcome);
	await context.db.persistence.flush();
	using chat = context.open();

	chat.inputValue = 'It was a lucid talk.';
	const sending = chat.sendMessage();
	expect(chat.inputValue).toBe('It was a lucid talk.');
	expect(chat.isSaving).toBe(true);
	expect(chat.canSend).toBe(false);

	await sending;
	expect(chat.inputValue).toBe('');
	await settle(chat);
	expect(context.tutor.requests).toBe(1);
	expect(roles(chat)).toEqual(['assistant', 'user', 'assistant']);
	expect(chat.unsaved).toEqual([]);
});

test('typing that arrives while the learner message is saving is not cleared', async () => {
	await using context = await setup();
	context.seed(welcome);
	await context.db.persistence.flush();
	using chat = context.open();

	chat.inputValue = 'It was a lucid talk.';
	const sending = chat.sendMessage();
	chat.inputValue = 'It was a lucid talk. Also,';
	await sending;
	expect(chat.inputValue).toBe('It was a lucid talk. Also,');
	await settle(chat);
	expect(roles(chat)).toEqual(['assistant', 'user', 'assistant']);
});

test('refused storage keeps the draft and asks the tutor nothing, and saving again asks nothing either', async () => {
	await using context = await setup();
	context.seed(welcome);
	await context.db.persistence.flush();
	using chat = context.open();

	context.gate.failing = true;
	chat.inputValue = 'It was a lucid talk.';
	await chat.sendMessage();
	await settle(chat);
	expect(context.tutor.requests).toBe(0);
	expect(chat.inputValue).toBe('It was a lucid talk.');
	expect(chat.saveError?.name).toBe('WriteFailed');
	expect(chat.unsaved.map((message) => message.role)).toEqual(['user']);
	expect(chat.canSend).toBe(false);

	// Neither a second send nor a tutor retry gets past the unsaved message.
	await chat.sendMessage();
	await chat.retry();
	await chat.saveAgain();
	expect(context.tutor.requests).toBe(0);
	expect(context.db.tables.messages.rows).toHaveLength(2);
	expect(chat.inputValue).toBe('It was a lucid talk.');

	context.gate.failing = false;
	await chat.saveAgain();
	expect(context.tutor.requests).toBe(0);
	expect(chat.inputValue).toBe('');
	expect(chat.unsaved).toEqual([]);
	expect(chat.saveError).toBeNull();
	expect(context.db.tables.messages.rows).toHaveLength(2);

	// Asking the tutor is the learner's separate step.
	await chat.retry();
	await settle(chat);
	expect(context.tutor.requests).toBe(1);
	expect(roles(chat)).toEqual(['assistant', 'user', 'assistant']);
});

test('a tutor answer that storage refuses is kept whole and saved again without a second tutor request', async () => {
	await using context = await setup();
	context.seed(welcome);
	context.seed({
		id: 'question',
		role: 'user',
		createdAt: 2,
		parts: [{ type: 'text', text: 'Is this right?' }],
	});
	await context.db.persistence.flush();
	using chat = context.open();

	await chat.retry();
	// Storage goes away while the tutor is answering.
	context.gate.failing = true;
	await settle(chat);
	expect(context.tutor.requests).toBe(1);
	expect(chat.error).toBeNull();
	expect(chat.saveError?.name).toBe('WriteFailed');
	const [kept] = chat.unsaved;
	expect(kept?.role).toBe('assistant');
	expect(roles(chat)).toEqual(['assistant', 'user', 'assistant']);

	chat.stop();
	await chat.retry();
	expect(context.tutor.requests).toBe(1);
	expect(chat.unsaved).toEqual(kept ? [kept] : []);

	context.gate.failing = false;
	await chat.saveAgain();
	expect(context.tutor.requests).toBe(1);
	expect(chat.unsaved).toEqual([]);
	expect(chat.messages.at(-1)).toEqual(kept);
	expect(context.db.tables.messages.rows).toHaveLength(3);
});

test('a tutor answer cut off at the output limit is a tutor failure and saves nothing', async () => {
	await using context = await setup();
	context.seed(welcome);
	context.seed({
		id: 'question',
		role: 'user',
		createdAt: 2,
		parts: [{ type: 'text', text: 'Is this right?' }],
	});
	await context.db.persistence.flush();
	using chat = context.open();

	context.tutor.finishReason = 'length';
	await chat.retry();
	await settle(chat);
	expect(context.tutor.requests).toBe(1);
	expect(chat.error?.code).toBe('length');
	expect(chat.saveError).toBeNull();
	expect(chat.unsaved).toEqual([]);
	expect(roles(chat)).toEqual(['assistant', 'user']);
	expect(context.db.tables.messages.rows).toHaveLength(2);
});

// ============================================================================
// Tutor opening over a new chat's focus
// ============================================================================

/** A new chat: nothing in the transcript, and the focus row just accepted. */
function startFocusedChat(context: Awaited<ReturnType<typeof setup>>) {
	startChat(context.db.tables.chats, 'account-a', [
		{ entryId: 'entry', text: 'lucid' },
	]);
}

test('opening requests that overlap while storage confirms the focus ask the tutor once, after storage', async () => {
	await using context = await setup();
	startFocusedChat(context);
	using chat = context.open();

	const storage = context.holdStorage();
	const first = chat.retry();
	const second = chat.retry();
	await Bun.sleep(0);
	expect(context.tutor.requests).toBe(0);
	// Asked, and stoppable, before the tutor has been reached.
	expect(chat.isGenerating).toBe(true);
	expect(chat.canAsk).toBe(false);

	storage.resolve();
	await Promise.all([first, second]);
	await settle(chat);
	expect(context.tutor.requests).toBe(1);
	expect(roles(chat)).toEqual(['assistant']);
	expect(context.db.persistence.get()).toBe('saved');
});

test('stop while storage is confirming the focus prevents the late tutor start', async () => {
	await using context = await setup();
	startFocusedChat(context);
	using chat = context.open();

	const storage = context.holdStorage();
	const opening = chat.retry();
	await Bun.sleep(0);
	chat.stop();
	expect(chat.isGenerating).toBe(false);
	storage.resolve();
	await opening;
	await settle(chat);
	expect(context.tutor.requests).toBe(0);
	expect(chat.saveError).toBeNull();

	// Stopped, not broken: the learner can ask again.
	await chat.retry();
	await settle(chat);
	expect(context.tutor.requests).toBe(1);
});

test('disposing the chat while storage is confirming the focus prevents the late tutor start', async () => {
	await using context = await setup();
	startFocusedChat(context);
	const chat = context.open();

	const storage = context.holdStorage();
	const opening = chat.retry();
	await Bun.sleep(0);
	chat[Symbol.dispose]();
	storage.resolve();
	await opening;
	await Bun.sleep(0);
	expect(context.tutor.requests).toBe(0);
	await chat.retry();
	expect(context.tutor.requests).toBe(0);
});

test('an opening over a focus that storage refuses asks nothing, reports a storage failure, and saving again does not ask either', async () => {
	await using context = await setup();
	context.gate.failing = true;
	startFocusedChat(context);
	using chat = context.open();

	await chat.retry();
	await settle(chat);
	expect(context.tutor.requests).toBe(0);
	expect(chat.saveError?.name).toBe('NotSaved');
	expect(chat.error).toBeNull();
	expect(chat.unsaved).toEqual([]);
	expect(chat.canAsk).toBe(false);

	// Asking again does not get past the storage failure, and a failed save
	// keeps reporting it.
	await chat.retry();
	await chat.saveAgain();
	expect(context.tutor.requests).toBe(0);
	expect(chat.saveError?.name).toBe('NotSaved');

	context.gate.failing = false;
	await chat.saveAgain();
	await settle(chat);
	expect(context.tutor.requests).toBe(0);
	expect(chat.saveError).toBeNull();
	expect(context.db.persistence.get()).toBe('saved');
	expect(chat.canAsk).toBe(true);

	await chat.retry();
	await settle(chat);
	expect(context.tutor.requests).toBe(1);
	expect(roles(chat)).toEqual(['assistant']);
});

test('a reopened chat asks nothing over a learner message that storage never took', async () => {
	await using context = await setup();
	context.seed(welcome);
	await context.db.persistence.flush();
	context.gate.failing = true;
	context.seed({
		id: 'question',
		role: 'user',
		createdAt: 2,
		parts: [{ type: 'text', text: 'Is this right?' }],
	});
	using reopened = context.open();

	await reopened.retry();
	await settle(reopened);
	expect(context.tutor.requests).toBe(0);
	expect(reopened.saveError?.name).toBe('NotSaved');
});
