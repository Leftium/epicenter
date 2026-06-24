/**
 * The Vocab inference engine: an {@link AgentEngine} the client agent loop
 * (ADR-0047) drives over the OpenAI-compatible wire (ADR-0049/0050). The
 * connection is chosen per turn from the conversation's model (ADR-0055/0058): the
 * model is resolved against the device's connection set, so the same model column
 * drives the hosted Epicenter gateway or a custom OpenAI-compatible server (a
 * local Ollama, your own gateway). Hosted serves the Chinese-tuned `VOCAB_MODEL`.
 *
 * Vocab is capability-free, so each turn is a single text step with an empty tool
 * catalog: the same engine a tool agent uses, with no tools.
 *
 * It lives outside the dep-free contract (`vocab.ts`) on purpose: it pulls in
 * `@epicenter/client`, so it is its own subpath (`@epicenter/vocab/engine`). The
 * caller supplies the conversation model and device connections as getters, so
 * this module stays free of app state.
 */

import {
	type AgentEngine,
	type Connection,
	createOpenAiAgentEngine,
	type ResolvedConnection,
	resolveConnection,
	resolveForModel,
} from '@epicenter/client';
import { VOCAB_MODEL, VOCAB_SYSTEM_PROMPT } from './vocab.js';

/** A custom (non-hosted) connection: the device holds a set of these. */
type CustomConnection = Extract<Connection, { kind: 'custom' }>;

/**
 * Build the candidate list `resolveForModel` matches a model against: the implicit
 * hosted connection (serving Vocab's one catalog model) plus each device
 * connection paired with the model ids it was discovered to serve. Shared by the
 * engine (to resolve a turn) and the chat surface (to detect the cross-device gap),
 * so both agree on what this device can serve.
 */
export function buildVocabCandidates(
	connections: readonly CustomConnection[],
	discoveredModels: Record<string, readonly string[]>,
): { connection: Connection; models: readonly string[] }[] {
	return [
		{ connection: { kind: 'hosted' }, models: [VOCAB_MODEL] },
		...connections.map((connection) => ({
			connection,
			models: discoveredModels[connection.baseUrl] ?? [],
		})),
	];
}

/**
 * Build the Vocab {@link AgentEngine}.
 *
 * @param hosted the resolved hosted transport (`auth.fetch` + the gateway base
 *   URL), used only when the conversation's model resolves to the hosted
 *   connection; a custom connection gets a plain fetch (ADR-0053/0054).
 * @param model reads the conversation's model per turn (ADR-0055), so a switch in
 *   the header picker takes effect on the next turn.
 * @param connections reads the device's custom connections per turn.
 * @param discoveredModels reads the per-connection discovered-model cache per turn.
 */
export function createVocabEngine({
	hosted,
	model,
	connections,
	discoveredModels,
}: {
	hosted: ResolvedConnection;
	model: () => string;
	connections: () => readonly CustomConnection[];
	discoveredModels: () => Record<string, readonly string[]>;
}): AgentEngine {
	return createOpenAiAgentEngine({
		data: () => {
			const currentModel = model();
			const candidates = buildVocabCandidates(
				connections(),
				discoveredModels(),
			);
			// The UI gates sending when a model is unavailable on this device, so the
			// hosted fallback is defensive: it errors loudly at the gateway rather than
			// silently substituting a different model.
			const connection = resolveForModel(currentModel, candidates) ?? {
				kind: 'hosted',
			};
			return {
				...resolveConnection(connection, hosted),
				model: currentModel,
				systemPrompts: [VOCAB_SYSTEM_PROMPT],
			};
		},
	});
}
