import { Ok } from 'wellcrafted/result';
import { createOpenAiCompatibleCompletionService } from './openai-compatible';
import { CompletionServiceErr } from './types';

export const CustomCompletionServiceLive =
	createOpenAiCompatibleCompletionService({
		providerLabel: 'Custom',
		getBaseUrl: (params) => params.baseUrl, // Use baseUrl from params
		validateParams: (params) => {
			if (!params.baseUrl) {
				return CompletionServiceErr({
					message: 'Custom provider requires a base URL.',
					context: { status: 400, name: 'MissingBaseUrl' },
					cause: null,
				});
			}
			if (!params.model) {
				return CompletionServiceErr({
					message: 'Custom provider requires a model name.',
					context: { status: 400, name: 'MissingModel' },
					cause: null,
				});
			}
			return Ok(undefined);
		},
	});

export type CustomCompletionService = typeof CustomCompletionServiceLive;
