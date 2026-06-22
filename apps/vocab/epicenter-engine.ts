/**
 * The Vocab inference engine: an {@link AgentEngine} the client agent loop
 * (ADR-0047) drives over the OpenAI-compatible wire (ADR-0049/0050). The backend
 * is chosen per turn from the device setting (ADR-0053): the metered Epicenter
 * gateway by default, or a custom OpenAI-compatible server (a local Ollama, your
 * own gateway). Hosted uses the Chinese-tuned `VOCAB_MODEL`; a custom backend
 * serves its own free-text model.
 *
 * Vocab is capability-free, so each turn is a single text step with an empty tool
 * catalog: the same engine a tool agent uses, with no tools.
 *
 * It lives outside the dep-free contract (`vocab.ts`) on purpose: it pulls in
 * `@epicenter/client`, so it is its own subpath (`@epicenter/vocab/engine`). The
 * caller supplies the device backend as a getter, so this module stays free of app
 * state.
 */

import type { AuthFetch } from '@epicenter/auth';
import {
	type AgentEngine,
	createOpenAiAgentEngine,
	type InferenceBackendConfig,
	resolveInferenceBackend,
} from '@epicenter/client';
import { API_ROUTES } from '@epicenter/constants/api-routes';
import { VOCAB_MODEL, VOCAB_SYSTEM_PROMPT } from './vocab.js';

/**
 * Build the Vocab {@link AgentEngine}.
 *
 * @param fetch the browser's authenticated fetch (`auth.fetch`), used only for the
 *   hosted Epicenter gateway; a custom backend gets a plain fetch (ADR-0052/0053).
 * @param baseURL the Epicenter API origin the hosted gateway lives under.
 * @param backend reads the device backend config per turn, so a switch takes
 *   effect on the next turn.
 */
export function createVocabEngine({
	fetch,
	baseURL,
	backend,
}: {
	fetch: AuthFetch;
	baseURL: string;
	backend: () => InferenceBackendConfig;
}): AgentEngine {
	const hostedBaseURL = API_ROUTES.ai.completions.baseUrl(baseURL);
	return createOpenAiAgentEngine({
		data: () => {
			const config = backend();
			return {
				...resolveInferenceBackend(config, { fetch, baseURL: hostedBaseURL }),
				model: config.mode === 'custom' ? config.model : VOCAB_MODEL,
				systemPrompts: [VOCAB_SYSTEM_PROMPT],
			};
		},
	});
}
