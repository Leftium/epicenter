import { describe, expect, test } from 'bun:test';
import { EventType, type StreamChunk } from '@tanstack/ai';
import * as Y from 'yjs';
import { attachKvStore } from '../document/attach-kv-store.js';
import { type AgentEngine, createConversation } from './loop.js';
import { type AgentMessage, agentMessageText } from './message.js';
import {
	type AgentToolCall,
	type Approval,
	defaultApprovalDecision,
	type ToolCatalog,
} from './tools.js';

/**
 * A disposable store over an in-memory doc, matching what `docs.open()` returns
 * in an app (the open wrapper adds disposal; `attachKvStore` alone does not).
 */
function makeStore() {
	const doc = new Y.Doc();
	const handle = attachKvStore<AgentMessage>(doc);
	return Object.assign(handle, {
		[Symbol.dispose]() {
			doc.destroy();
		},
	});
}

/** Build a stream chunk loosely; tests do not need full AG-UI field fidelity. */
function chunk(fields: {
	type: EventType;
	[key: string]: unknown;
}): StreamChunk {
	return fields as unknown as StreamChunk;
}

function streamOf(chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
	return (async function* () {
		for (const value of chunks) yield value;
	})();
}

/** A monotonic id minter for deterministic message ids. */
function idMinter() {
	let n = 0;
	return () => `m${++n}`;
}

/** Drive pending turns to completion. */
async function settle(handle: { snapshot(): { isGenerating: boolean } }) {
	for (let i = 0; i < 200 && handle.snapshot().isGenerating; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

describe('createConversation', () => {
	test('persists a finished text turn as user + assistant messages', async () => {
		const store = makeStore();
		const engine: AgentEngine = () =>
			streamOf([
				chunk({
					type: EventType.TEXT_MESSAGE_CONTENT,
					delta: 'Hello',
					messageId: 'a',
				}),
				chunk({
					type: EventType.TEXT_MESSAGE_CONTENT,
					delta: ' world',
					messageId: 'a',
				}),
				chunk({ type: EventType.RUN_FINISHED, finishReason: 'stop' }),
			]);

		const handle = createConversation({
			store,
			engine,
			generateId: idMinter(),
		});
		handle.send('hi');
		await settle(handle);

		const messages = handle.snapshot().messages;
		expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
		expect(agentMessageText(messages[0]!)).toBe('hi');
		expect(agentMessageText(messages[1]!)).toBe('Hello world');
		expect(handle.snapshot().isGenerating).toBe(false);
		// The finished messages are durable: a fresh read of the store sees them.
		expect([...store.entries()]).toHaveLength(2);
	});

	test('runs a query tool inline and re-prompts with its result', async () => {
		const store = makeStore();
		let stepCount = 0;
		const engine: AgentEngine = () => {
			stepCount += 1;
			if (stepCount === 1) {
				return streamOf([
					chunk({
						type: EventType.TOOL_CALL_START,
						toolCallId: 't1',
						toolCallName: 'get_time',
					}),
					chunk({
						type: EventType.TOOL_CALL_ARGS,
						toolCallId: 't1',
						delta: '{}',
					}),
					chunk({ type: EventType.TOOL_CALL_END, toolCallId: 't1' }),
					chunk({ type: EventType.RUN_FINISHED, finishReason: 'tool_calls' }),
				]);
			}
			return streamOf([
				chunk({
					type: EventType.TEXT_MESSAGE_CONTENT,
					delta: 'It is noon.',
					messageId: 'b',
				}),
				chunk({ type: EventType.RUN_FINISHED, finishReason: 'stop' }),
			]);
		};
		const resolved: AgentToolCall[] = [];
		const tools: ToolCatalog = {
			definitions: () => [{ name: 'get_time', kind: 'query' }],
			resolve: async (call) => {
				resolved.push(call);
				return { output: 'noon', isError: false };
			},
		};

		const handle = createConversation({
			store,
			engine,
			tools,
			generateId: idMinter(),
		});
		handle.send('what time is it');
		await settle(handle);

		expect(resolved.map((c) => c.toolName)).toEqual(['get_time']);
		const messages = handle.snapshot().messages;
		expect(messages.map((m) => m.role)).toEqual([
			'user',
			'assistant',
			'assistant',
		]);

		const toolStep = messages[1]!;
		expect(toolStep.parts.find((p) => p.type === 'tool-call')).toMatchObject({
			toolName: 'get_time',
		});
		expect(toolStep.parts.find((p) => p.type === 'tool-result')).toMatchObject({
			output: 'noon',
			isError: false,
		});
		expect(agentMessageText(messages[2]!)).toBe('It is noon.');
	});

	test('an asked mutation that is declined records a denial, never resolves', async () => {
		const store = makeStore();
		let stepCount = 0;
		const engine: AgentEngine = () => {
			stepCount += 1;
			if (stepCount === 1) {
				return streamOf([
					chunk({
						type: EventType.TOOL_CALL_START,
						toolCallId: 'd1',
						toolCallName: 'delete_all',
					}),
					chunk({ type: EventType.TOOL_CALL_END, toolCallId: 'd1', input: {} }),
					chunk({ type: EventType.RUN_FINISHED, finishReason: 'tool_calls' }),
				]);
			}
			return streamOf([
				chunk({
					type: EventType.TEXT_MESSAGE_CONTENT,
					delta: 'Okay, I will not.',
					messageId: 'c',
				}),
				chunk({ type: EventType.RUN_FINISHED, finishReason: 'stop' }),
			]);
		};
		let resolveCalled = false;
		const tools: ToolCatalog = {
			definitions: () => [{ name: 'delete_all', kind: 'mutation' }],
			resolve: async () => {
				resolveCalled = true;
				return { output: 'deleted', isError: false };
			},
		};
		const approval: Approval = {
			decide: defaultApprovalDecision,
			request: async () => false,
		};

		const handle = createConversation({
			store,
			engine,
			tools,
			approval,
			generateId: idMinter(),
		});
		handle.send('delete everything');
		await settle(handle);

		expect(resolveCalled).toBe(false);
		const toolStep = handle.snapshot().messages[1]!;
		expect(toolStep.parts.find((p) => p.type === 'tool-result')).toMatchObject({
			isError: true,
		});
	});

	test('an aborted turn drops its assistant message, keeping only the user turn', async () => {
		const store = makeStore();
		const engine: AgentEngine = () =>
			streamOf([
				chunk({
					type: EventType.TEXT_MESSAGE_CONTENT,
					delta: 'partial',
					messageId: 'x',
				}),
				chunk({ type: EventType.RUN_FINISHED, finishReason: 'stop' }),
			]);

		const handle = createConversation({
			store,
			engine,
			generateId: idMinter(),
		});
		handle.send('hi');
		handle.stop();
		await settle(handle);

		const messages = handle.snapshot().messages;
		expect(messages.map((m) => m.role)).toEqual(['user']);
		expect(handle.snapshot().isGenerating).toBe(false);
	});
});
