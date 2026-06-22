/**
 * The legacy Epicenter provider: {@link createEpicenterAgentEngine}, an
 * {@link AgentEngine} the client agent loop (ADR-0047) drives. It runs inference
 * through the metered `/api/ai/chat` endpoint on the user's account (the house
 * key), so the loop gets credits without a raw provider key (ADR-0033's
 * Epicenter-provider backend). A request carries the prompt plus the live tool
 * catalog, and the engine forwards the tool definitions in the request body so
 * the provider emits tool-call chunks.
 *
 * The endpoint streams the answer back as Server-Sent Events
 * (`toServerSentEventsResponse`), the way a provider streams. This adapter parses
 * those `data:` frames (raw AG-UI `StreamChunk`s) and maps each to the loop's own
 * {@link EngineChunk} vocabulary, so the loop is decoupled from the AG-UI wire.
 *
 * This is the pre-OpenAI-compatible path (ADR-0050). It coexists with the
 * OpenAI-compatible engine (`openai-provider.ts`) until the AG-UI server route is
 * deleted, at which point this file and its `@tanstack/ai` dependency go.
 *
 * This lives in `@epicenter/client` (beside `createAiChatFetch`, the authed fetch
 * it expects) so every app that answers a cloud conversation in-process shares
 * one implementation.
 */

import { AiChatHttpError } from '@epicenter/constants/ai-chat-errors';
import { EventType, type StreamChunk } from '@tanstack/ai';
import { extractErrorMessage } from 'wellcrafted/error';
import type { JsonValue } from 'wellcrafted/json';
import type {
	AgentEngine,
	AgentEngineToolDefinition,
	EngineChunk,
} from './agent-engine.js';

/** The body options the `/api/ai/chat` route reads (model + system prompts). */
export type EpicenterProviderData = {
	model: string;
	systemPrompts: string[];
};

/**
 * Map one raw AG-UI `StreamChunk` frame to the loop's {@link EngineChunk}, or
 * `null` to drop a frame the loop does not consume (lifecycle markers like
 * `RUN_STARTED`, `TEXT_MESSAGE_START`, `RUN_FINISHED`). A `RUN_ERROR` is
 * flattened: TanStack's `toServerSentEventsStream` nests a run failure under
 * `error` rather than at top level, so without flattening the loop would see an
 * undefined message and lose the structured code.
 */
function toEngineChunk(chunk: StreamChunk): EngineChunk | null {
	switch (chunk.type) {
		case EventType.TEXT_MESSAGE_CONTENT:
			return { type: 'text-delta', delta: chunk.delta };
		case EventType.TOOL_CALL_START:
			return {
				type: 'tool-call-start',
				toolCallId: chunk.toolCallId,
				toolName: chunk.toolCallName,
			};
		case EventType.TOOL_CALL_ARGS:
			return {
				type: 'tool-call-args',
				toolCallId: chunk.toolCallId,
				delta: chunk.delta,
			};
		case EventType.TOOL_CALL_END:
			return {
				type: 'tool-call-end',
				toolCallId: chunk.toolCallId,
				...(chunk.toolCallName !== undefined && {
					toolName: chunk.toolCallName,
				}),
				...(chunk.input !== undefined && { input: chunk.input as JsonValue }),
			};
		case EventType.RUN_ERROR: {
			const frame = chunk as {
				message?: string;
				code?: string;
				error?: { message?: string; code?: string };
			};
			if (frame.error) {
				return {
					type: 'run-error',
					message: frame.error.message ?? 'The model run failed.',
					code: frame.error.code ?? 'stream-error',
				};
			}
			return {
				type: 'run-error',
				message: frame.message ?? 'The model run failed.',
				...(frame.code !== undefined && { code: frame.code }),
			};
		}
		default:
			return null;
	}
}

/**
 * Parse an SSE chat response into the loop's {@link EngineChunk} stream. Frames
 * are double-newline separated; each carries one JSON `StreamChunk` on a `data:`
 * line, and a `[DONE]` sentinel ends the run. A malformed or unconsumed frame is
 * skipped (a hole, not a crash), matching the loop's tolerance for untrusted
 * input.
 */
async function* parseServerSentEvents(
	response: Response,
	signal: AbortSignal,
): AsyncIterable<EngineChunk> {
	if (!response.body) return;
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	try {
		while (!signal.aborted) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const frames = buffer.split('\n\n');
			// The last element is an incomplete frame; keep it for the next read.
			buffer = frames.pop() ?? '';
			for (const frame of frames) {
				const dataLine = frame
					.split('\n')
					.find((line) => line.startsWith('data:'));
				if (!dataLine) continue;
				const data = dataLine.slice('data:'.length).trimStart();
				if (data === '' || data === '[DONE]') continue;
				let parsed: StreamChunk;
				try {
					parsed = JSON.parse(data) as StreamChunk;
				} catch {
					continue; // Skip a frame that is not valid JSON.
				}
				const engineChunk = toEngineChunk(parsed);
				if (engineChunk) yield engineChunk;
			}
		}
	} finally {
		reader.releaseLock();
	}
}

/**
 * Project a tool definition to the wire `Tool` the route forwards to the
 * provider (`{ name, description, inputSchema }`). The description is required on
 * the wire, so it falls back to the tool name. An object input schema gets
 * `properties` / `required` defaulted, which some providers (notably Anthropic)
 * reject when absent.
 */
function toWireTool(definition: AgentEngineToolDefinition): {
	name: string;
	description: string;
	inputSchema?: unknown;
} {
	return {
		name: definition.name,
		description: definition.description ?? definition.name,
		...(definition.inputSchema !== undefined && {
			inputSchema: normalizeInputSchema(definition.inputSchema),
		}),
	};
}

function normalizeInputSchema(schema: unknown): unknown {
	if (
		typeof schema !== 'object' ||
		schema === null ||
		(schema as { type?: unknown }).type !== 'object'
	) {
		return schema;
	}
	const object = schema as Record<string, unknown>;
	return {
		...object,
		properties: object.properties ?? {},
		required: object.required ?? [],
	};
}

/**
 * Build the Epicenter-provider {@link AgentEngine} the client agent loop drives.
 * `fetch` is an authenticated fetch that reads the structured error body
 * (`createAiChatFetch`), `url` is the `/api/ai/chat` endpoint, and `data()` is
 * read per turn so a mid-conversation model switch takes effect on the next
 * step. The request's `tools` (the live catalog for this step) are forwarded as
 * wire tool definitions so the provider emits tool-call chunks.
 */
export function createEpicenterAgentEngine({
	fetch,
	url,
	data,
}: {
	fetch: typeof globalThis.fetch;
	url: string;
	data: () => EpicenterProviderData;
}): AgentEngine {
	return async function* (request, signal) {
		const body = {
			messages: request.messages,
			data: {
				...data(),
				...(request.tools.length > 0 && {
					tools: request.tools.map(toWireTool),
				}),
			},
		};

		let response: Response;
		try {
			response = await fetch(url, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					accept: 'text/event-stream',
				},
				body: JSON.stringify(body),
				signal,
			});
		} catch (error) {
			if (signal.aborted) return;
			// `createAiChatFetch` throws `AiChatHttpError` on a non-2xx response,
			// carrying the server's structured error; surface its name as the
			// run-error code so the failed turn stays branchable.
			if (error instanceof AiChatHttpError) {
				yield {
					type: 'run-error',
					code: error.detail.name,
					message: error.detail.message,
				};
				return;
			}
			yield {
				type: 'run-error',
				code: 'stream-error',
				message: extractErrorMessage(error),
			};
			return;
		}
		yield* parseServerSentEvents(response, signal);
	};
}
