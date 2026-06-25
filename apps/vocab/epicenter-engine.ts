/**
 * The Vocab inference engine: an {@link AgentEngine} the client agent loop
 * (ADR-0047) drives over the OpenAI-compatible wire (ADR-0049/0050). The
 * connection is chosen per turn by resolving the conversation's model
 * (ADR-0055/0059) against the device's connection registry: the model column
 * drives the hosted Epicenter gateway or a custom OpenAI-compatible server (a
 * local Ollama, your own gateway) alike. Hosted serves the Chinese-tuned
 * `VOCAB_MODEL`.
 *
 * Vocab is capability-free, so each turn is a single text step with an empty tool
 * catalog: the same engine a tool agent uses, with no tools.
 *
 * It lives outside the dep-free contract (`vocab.ts`) on purpose: it pulls in
 * `@epicenter/client`, so it is its own subpath (`@epicenter/vocab/engine`). The
 * caller supplies the conversation model as a getter and the device registry, so
 * this module stays free of app state.
 */

import type { InferenceConnections } from '@epicenter/app-shell/inference-picker';
import { type AgentEngine, createOpenAiAgentEngine } from '@epicenter/client';
import { VOCAB_SYSTEM_PROMPT } from './vocab.js';

/**
 * Build the Vocab {@link AgentEngine}.
 *
 * @param model reads the conversation's model per turn (ADR-0055), so a switch in
 *   the header picker takes effect on the next turn.
 * @param connections the device's connection registry; `resolveOrHosted` turns the
 *   model into a transport (the hosted fallback when no device connection serves it).
 */
export function createVocabEngine({
	model,
	connections,
}: {
	model: () => string;
	connections: InferenceConnections;
}): AgentEngine {
	return createOpenAiAgentEngine({
		data: () => {
			const currentModel = model();
			// `resolveOrHosted` falls back to the hosted gateway for a model no device
			// connection serves; the UI gates sending in that case, so the fallback only
			// errors loudly rather than silently substituting a different model.
			const transport = connections.resolveOrHosted(currentModel);
			return {
				...transport,
				model: currentModel,
				systemPrompts: [VOCAB_SYSTEM_PROMPT],
			};
		},
	});
}
