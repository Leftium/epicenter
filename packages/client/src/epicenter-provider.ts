/**
 * The Epicenter provider: {@link createEpicenterAgentEngine}, the `AgentEngine`
 * the client agent loop (ADR-0047) drives. It runs inference through the metered
 * `/api/ai/chat` endpoint on the user's account (the house key), so the loop
 * gets credits without a raw provider key (ADR-0033's Epicenter-provider
 * backend). A request carries the prompt plus the live tool catalog, and the
 * engine forwards the tool definitions in the request body so the provider emits
 * tool-call chunks. The capability-free case (Vocab) sends an empty catalog and
 * the loop runs a single text step per turn; it is the same engine, no tools.
 *
 * The endpoint streams the answer back as Server-Sent Events
 * (`toServerSentEventsResponse`), the way a provider streams; this adapter turns
 * that wire format back into the raw AG-UI `StreamChunk` iterable the loop
 * consumes. TanStack ai-client (0.28.0) exposes no standalone SSE parser, only
 * `fetchServerSentEvents`, a full connection adapter that would POST an AG-UI
 * `RunAgentInput` envelope this custom `/api/ai/chat` contract does not speak,
 * so the `data:` frames are parsed here (verified; see ADR-0037).
 *
 * This lives in `@epicenter/client` (beside `createAiChatFetch`, the authed fetch
 * it expects) so every app that answers a cloud conversation in-process shares one
 * implementation. The return value is structurally the workspace loop's
 * `AgentEngine`; the types are inlined here to keep the client decoupled from the
 * workspace core.
 */

import { AiChatHttpError } from '@epicenter/constants/ai-chat-errors';
import { EventType, type ModelMessage, type StreamChunk } from '@tanstack/ai';
import { extractErrorMessage } from 'wellcrafted/error';

/** The body options the `/api/ai/chat` route reads (model + system prompts). */
export type EpicenterProviderData = {
	model: string;
	systemPrompts: string[];
};

/**
 * One tool offered to the model, the subset the wire needs. Structurally the
 * loop's `AgentToolDefinition` (`@epicenter/workspace/agent`), inlined so the
 * client stays decoupled from the workspace core. `kind` and `title` are loop
 * concerns; the wire needs only the name, description, and input schema.
 */
export type AgentEngineToolDefinition = {
	name: string;
	description?: string;
	inputSchema?: unknown;
};

/**
 * Structurally the loop's `AgentEngineRequest`: the snapshotted prompt plus the
 * live tool catalog for this step.
 */
export type AgentEngineRequest = {
	messages: ModelMessage[];
	tools: AgentEngineToolDefinition[];
};

/**
 * Structurally the loop's `AgentEngine` (`@epicenter/workspace/agent`): one
 * model call, a request in, a stream of AG-UI chunks out.
 */
export type AgentEngine = (
	request: AgentEngineRequest,
	signal: AbortSignal,
) => AsyncIterable<StreamChunk>;

/**
 * A `RUN_ERROR` chunk the loop turns into a failed turn. Carrying the structured
 * error `name` as the chunk `code` lets the failed turn keep
 * `InsufficientCredits` / `Unauthorized`, so the UI can branch on the code
 * instead of matching a message string.
 */
function runErrorChunk(code: string, message: string): StreamChunk {
	return { type: EventType.RUN_ERROR, code, message } as StreamChunk;
}

/**
 * Flatten a mid-stream failure to the AG-UI top-level shape the loop reads.
 * TanStack's `toServerSentEventsStream` emits a run failure as
 * `{ type: RUN_ERROR, error: { message, code } }` rather than top-level
 * `message`/`code`, so without this the loop sees an undefined message and loses
 * the code. A spec-compliant frame (or any non-error chunk) passes through.
 */
function normalizeChunk(chunk: StreamChunk): StreamChunk {
	if (chunk.type !== EventType.RUN_ERROR) return chunk;
	const nested = (chunk as { error?: { message?: string; code?: string } })
		.error;
	if (!nested) return chunk;
	return runErrorChunk(
		nested.code ?? 'stream-error',
		nested.message ?? 'The model run failed.',
	);
}

/**
 * Parse an SSE chat response into the raw `StreamChunk` stream. Frames are
 * double-newline separated; each carries one JSON chunk on a `data:` line, and a
 * `[DONE]` sentinel ends the run. A malformed frame is skipped (a hole, not a
 * crash), matching the loop's tolerance for untrusted input.
 */
async function* parseServerSentEvents(
	response: Response,
	signal: AbortSignal,
): AsyncIterable<StreamChunk> {
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
				try {
					yield normalizeChunk(JSON.parse(data) as StreamChunk);
				} catch {
					// Skip a frame that is not valid JSON.
				}
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
			// RUN_ERROR code so the failed turn stays branchable.
			if (error instanceof AiChatHttpError) {
				yield runErrorChunk(error.detail.name, error.detail.message);
				return;
			}
			yield runErrorChunk('stream-error', extractErrorMessage(error));
			return;
		}
		yield* parseServerSentEvents(response, signal);
	};
}
