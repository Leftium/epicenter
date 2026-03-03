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
				catch: (error) => {
					// Check if it's NOT an Anthropic API error
					if (!(error instanceof Anthropic.APIError)) {
						// This is an unexpected error type
						throw error;
					}
					// Return the error directly
					return Err(error);
				},
			});

			if (anthropicApiError) {
				// Error handling follows https://www.npmjs.com/package/@anthropic-ai/sdk#error-handling
				const { status, name } = anthropicApiError;

				if (status === 400)
					return CompletionError.BadRequest({ cause: anthropicApiError });

				if (status === 401)
					return CompletionError.Unauthorized({ cause: anthropicApiError });

				if (status === 403)
					return CompletionError.Forbidden({ cause: anthropicApiError });

				if (status === 404)
					return CompletionError.ModelNotFound({ cause: anthropicApiError });

				if (status === 422)
					return CompletionError.UnprocessableEntity({ cause: anthropicApiError });

				if (status === 429)
					return CompletionError.RateLimit({ cause: anthropicApiError });

				if (status && status >= 500)
					return CompletionError.ServerError({ cause: anthropicApiError });

				if (!status && name === 'APIConnectionError')
					return CompletionError.ConnectionFailed({ cause: anthropicApiError });

				return CompletionError.Api({ cause: anthropicApiError });
			}

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
