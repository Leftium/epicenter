import Anthropic from '@anthropic-ai/sdk';
import { Err, Ok, tryAsync } from 'wellcrafted/result';
import type { CompletionService } from './types';
import { CompletionError } from './types';

export function createAnthropicCompletionService(): CompletionService {
	return {
		async complete({ apiKey, model, systemPrompt, userPrompt }) {
			const client = new Anthropic({
				apiKey,
				// Enable browser usage
				dangerouslyAllowBrowser: true,
			});
			// Call Anthropic API
			const { data: completion, error: anthropicApiError } = await tryAsync({
				try: () =>
					client.messages.create({
						model,
						system: systemPrompt,
						messages: [{ role: 'user', content: userPrompt }],
						max_tokens: 1024,
					}),
				catch: (error): Err<CompletionError> => {
					if (!(error instanceof Anthropic.APIError)) throw error;
					if (!error.status && error.name === 'APIConnectionError') {
						return CompletionError.ConnectionFailed({ cause: error });
					}
					return CompletionError.Http({ status: error.status ?? 0, cause: error });
				},
			});

			if (anthropicApiError) return Err(anthropicApiError);

			// Extract the response text
			const responseText = completion.content
				.filter((block) => block.type === 'text')
				.map((block) => block.text)
				.join('');

			if (!responseText) {
				return CompletionError.EmptyResponse({
					providerLabel: 'Anthropic',
				});
			}

			return Ok(responseText);
		},
	};
}

export type AnthropicCompletionService = ReturnType<
	typeof createAnthropicCompletionService
>;

export const AnthropicCompletionServiceLive =
	createAnthropicCompletionService();
