import { createOpenAiCompatibleCompletionService } from './openai-compatible';

export const GroqCompletionServiceLive =
	createOpenAiCompatibleCompletionService({
		providerLabel: 'Groq',
		// Honor the user's endpoint override; fall back to the official Groq API
		getBaseUrl: (params) => params.baseUrl || 'https://api.groq.com/openai/v1',
	});
