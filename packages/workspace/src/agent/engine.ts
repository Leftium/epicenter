/**
 * The inference-engine seam (ADR-0049/0050): the small, framework-agnostic
 * contract the client agent loop drives. An engine turns one snapshotted prompt
 * plus a tool catalog into a stream of {@link EngineChunk}s; the loop reduces
 * those chunks into messages and runs the tools it asked for.
 *
 * This vocabulary is the loop's own, not a vendor SDK's. An OpenAI-compatible
 * engine parses OpenAI SSE deltas into these chunks; the legacy Epicenter engine
 * maps AG-UI frames into them while it coexists. Either way the loop only ever
 * sees an {@link EngineChunk}, so swapping the inference backend is the engine's
 * concern, never the loop's.
 */
import type { JsonValue } from 'wellcrafted/json';
import type { ModelMessage } from './message.js';
import type { AgentToolDefinition } from './tools.js';

/**
 * One streamed event from an engine. The minimal set the loop reduces: prose
 * deltas, the three stages of a tool call, a turn-ending failure, and a finish
 * marker. The loop ends a turn on "no tool calls collected", never on
 * {@link finishReason}, so a `run-finished` chunk is informational.
 */
export type EngineChunk =
	| { type: 'text-delta'; delta: string }
	| { type: 'tool-call-start'; toolCallId: string; toolName: string }
	| { type: 'tool-call-args'; toolCallId: string; delta: string }
	| {
			type: 'tool-call-end';
			toolCallId: string;
			toolName?: string;
			input?: JsonValue;
	  }
	| { type: 'run-error'; message: string; code?: string }
	| { type: 'run-finished'; finishReason?: string };

/** What the loop asks the model on one step: the prompt plus the live tools. */
export type AgentEngineRequest = {
	messages: ModelMessage[];
	tools: AgentToolDefinition[];
};

/**
 * One model call: a snapshotted prompt and the available tools in, a stream of
 * {@link EngineChunk}s out. It runs one model invocation and never executes a
 * tool or reads the store (ADR-0033's pure token source). The Epicenter metered
 * stream, a self-hosted gateway, and a local model all satisfy it.
 */
export type AgentEngine = (
	request: AgentEngineRequest,
	signal: AbortSignal,
) => AsyncIterable<EngineChunk>;
