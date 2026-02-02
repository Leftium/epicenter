import { Ok } from 'wellcrafted/result';
import { createOpenAiCompatibleCompletionService } from './openai-compatible';
import { CompletionServiceErr } from './types';

/**
 * Custom completion service for local LLM endpoints (Ollama, LM Studio, llama.cpp, etc.)
 * Uses the OpenAI-compatible API pattern that most local servers support.
 */
export const CustomCompletionServiceLive =
	createOpenAiCompatibleCompletionService({
		providerLabel: 'Custom',
		getBaseUrl: (params) => params.baseUrl,
		validateParams: (params) => {
			if (!params.baseUrl) {
				return CompletionServiceErr({
					message: 'Custom provider requires a base URL.',
				});
			}
			if (!params.model) {
				return CompletionServiceErr({
					message: 'Custom provider requires a model name.',
				});
			}
			return Ok(undefined);
		},
	});

export type CustomCompletionService = typeof CustomCompletionServiceLive;
