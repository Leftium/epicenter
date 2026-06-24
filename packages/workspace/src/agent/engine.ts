/**
 * The inference-engine seam (ADR-0049/0050): the small, framework-agnostic
 * contract the client agent loop drives. An engine turns one snapshotted prompt
 * plus a tool catalog into a stream of {@link EngineChunk}s; the loop reduces
 * those chunks into messages and runs the tools it asked for.
 *
 * The contract itself lives in `@epicenter/agent-protocol`, the leaf both this
 * loop and the OpenAI-compatible engine in `@epicenter/client` import, so the
 * wire shape cannot drift between producer and consumer. This module re-exports
 * it as the loop's own surface; the loop only ever sees an {@link EngineChunk},
 * so swapping the inference backend is the engine's concern, never the loop's.
 */
export type {
	AgentEngine,
	AgentEngineRequest,
	AgentEngineToolDefinition,
	EngineChunk,
} from '@epicenter/agent-protocol';
