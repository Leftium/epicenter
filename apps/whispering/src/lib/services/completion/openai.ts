import { createOpenAiCompatibleCompletionService } from './openai-compatible';

export const OpenaiCompletionServiceLive =
	createOpenAiCompatibleCompletionService({
		providerLabel: 'OpenAI',
		// Honor the user's endpoint override; fall back to the OpenAI SDK default
		getBaseUrl: (params) => params.baseUrl || undefined,
	});
