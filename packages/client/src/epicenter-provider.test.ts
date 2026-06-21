/**
 * The Epicenter agent engine forwards the live tool catalog to `/api/ai/chat`
 * (the wire gap ADR-0047 closes) and parses the SSE reply into chunks. A fake
 * `fetch` captures the request body and returns a canned SSE stream, so this
 * exercises the real body builder and the real SSE parser without a network.
 */

import { describe, expect, test } from 'bun:test';
import { EventType, type StreamChunk } from '@tanstack/ai';
import {
	type AgentEngineRequest,
	createEpicenterAgentEngine,
} from './epicenter-provider.js';

function sseResponse(chunks: StreamChunk[]): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(
					encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
				);
			}
			controller.close();
		},
	});
	return new Response(body, {
		status: 200,
		headers: { 'content-type': 'text/event-stream' },
	});
}

function textChunk(delta: string): StreamChunk {
	return {
		type: EventType.TEXT_MESSAGE_CONTENT,
		messageId: 'm1',
		delta,
	} as StreamChunk;
}

/** A `fetch` that records the last request body and returns a fixed Response. */
function capturingFetch(response: Response) {
	const calls: Array<Record<string, unknown>> = [];
	const fetch = (async (_url: string, init?: RequestInit) => {
		calls.push(JSON.parse(String(init?.body)));
		return response;
	}) as unknown as typeof globalThis.fetch;
	return { fetch, calls };
}

async function drain(
	stream: AsyncIterable<StreamChunk>,
): Promise<StreamChunk[]> {
	const out: StreamChunk[] = [];
	for await (const chunk of stream) out.push(chunk);
	return out;
}

describe('createEpicenterAgentEngine', () => {
	test('forwards tool definitions as wire tools and streams the reply', async () => {
		const { fetch, calls } = capturingFetch(
			sseResponse([textChunk('Hello'), textChunk(', world')]),
		);
		const engine = createEpicenterAgentEngine({
			fetch,
			url: 'https://example.test/api/ai/chat',
			data: () => ({ model: 'gpt-5.5', systemPrompts: ['sys'] }),
		});

		const request: AgentEngineRequest = {
			messages: [{ role: 'user', content: 'hi' }],
			tools: [
				{
					name: 'files_read',
					description: 'Read a file',
					inputSchema: {
						type: 'object',
						properties: { path: { type: 'string' } },
						required: ['path'],
					},
				},
			],
		};
		const chunks = await drain(engine(request, new AbortController().signal));

		// The SSE reply parsed into text chunks.
		expect(
			chunks
				.filter((c) => c.type === EventType.TEXT_MESSAGE_CONTENT)
				.map((c) => (c as { delta: string }).delta)
				.join(''),
		).toBe('Hello, world');

		// The body carried the model, prompts, and the wire tool definition.
		const body = calls[0] ?? {};
		const data = body.data as Record<string, unknown>;
		expect(data.model).toBe('gpt-5.5');
		expect(data.systemPrompts).toEqual(['sys']);
		expect(data.tools).toEqual([
			{
				name: 'files_read',
				description: 'Read a file',
				inputSchema: {
					type: 'object',
					properties: { path: { type: 'string' } },
					required: ['path'],
				},
			},
		]);
	});

	test('defaults a missing description and normalizes a bare object schema', async () => {
		const { fetch, calls } = capturingFetch(sseResponse([textChunk('ok')]));
		const engine = createEpicenterAgentEngine({
			fetch,
			url: 'https://example.test/api/ai/chat',
			data: () => ({ model: 'gpt-5.5', systemPrompts: [] }),
		});

		await drain(
			engine(
				{
					messages: [{ role: 'user', content: 'go' }],
					tools: [{ name: 'do_thing', inputSchema: { type: 'object' } }],
				},
				new AbortController().signal,
			),
		);

		const data = (calls[0] ?? {}).data as Record<string, unknown>;
		expect(data.tools).toEqual([
			{
				name: 'do_thing',
				description: 'do_thing',
				inputSchema: { type: 'object', properties: {}, required: [] },
			},
		]);
	});

	test('flattens a mid-stream RUN_ERROR with a nested error payload', async () => {
		// TanStack's SSE emits a run failure nested under `error`, not top-level.
		const nestedError = {
			type: EventType.RUN_ERROR,
			error: { message: 'the model failed', code: 'ModelFailed' },
		} as unknown as StreamChunk;
		const { fetch } = capturingFetch(sseResponse([nestedError]));
		const engine = createEpicenterAgentEngine({
			fetch,
			url: 'https://example.test/api/ai/chat',
			data: () => ({ model: 'gpt-5.5', systemPrompts: [] }),
		});

		const chunks = await drain(
			engine(
				{ messages: [{ role: 'user', content: 'go' }], tools: [] },
				new AbortController().signal,
			),
		);

		const error = chunks.find((c) => c.type === EventType.RUN_ERROR) as
			| { message?: string; code?: string }
			| undefined;
		expect(error?.message).toBe('the model failed');
		expect(error?.code).toBe('ModelFailed');
	});

	test('omits the tools key entirely when the catalog is empty', async () => {
		const { fetch, calls } = capturingFetch(sseResponse([textChunk('ok')]));
		const engine = createEpicenterAgentEngine({
			fetch,
			url: 'https://example.test/api/ai/chat',
			data: () => ({ model: 'gpt-5.5', systemPrompts: [] }),
		});

		await drain(
			engine(
				{ messages: [{ role: 'user', content: 'go' }], tools: [] },
				new AbortController().signal,
			),
		);

		const data = (calls[0] ?? {}).data as Record<string, unknown>;
		expect('tools' in data).toBe(false);
	});
});
