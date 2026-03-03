import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import Groq from 'groq-sdk';
import { Err, Ok, tryAsync } from 'wellcrafted/result';
import type { CompletionService } from './types';
import { CompletionError } from './types';

const customFetch = window.__TAURI_INTERNALS__ ? tauriFetch : undefined;

export const GroqCompletionServiceLive: CompletionService = {
	async complete({ apiKey, model, systemPrompt, userPrompt }) {
		const client = new Groq({
			apiKey,
			dangerouslyAllowBrowser: true,
			fetch: customFetch,
		});
		// Call Groq API
		const { data: completion, error: groqApiError } = await tryAsync({
			try: () =>
				client.chat.completions.create({
					model,
					messages: [
						{ role: 'system', content: systemPrompt },
						{ role: 'user', content: userPrompt },
					],
				}),
			catch: (error) => {
				// Check if it's NOT a Groq API error
				if (!(error instanceof Groq.APIError)) {
					// This is an unexpected error type
					throw error;
				}
				// Return the error directly
				return Err(error);
			},
		});

		if (groqApiError) {
			// Error handling follows https://www.npmjs.com/package/groq-sdk#error-handling
			const { status, name } = groqApiError;

			if (status === 400)
				return CompletionError.BadRequest({ cause: groqApiError });

			if (status === 401)
				return CompletionError.Unauthorized({ cause: groqApiError });

			if (status === 403)
				return CompletionError.Forbidden({ cause: groqApiError });

			if (status === 404)
				return CompletionError.ModelNotFound({ cause: groqApiError });

			if (status === 422)
				return CompletionError.UnprocessableEntity({ cause: groqApiError });

			if (status === 429)
				return CompletionError.RateLimit({ cause: groqApiError });

			if (status && status >= 500)
				return CompletionError.ServerError({ cause: groqApiError });

			if (!status && name === 'APIConnectionError')
				return CompletionError.ConnectionFailed({ cause: groqApiError });

			return CompletionError.Api({ cause: groqApiError });
		}

		// Extract the response text
		const responseText = completion.choices.at(0)?.message?.content;
		if (!responseText) {
			return CompletionError.EmptyResponse({
				providerLabel: 'Groq',
			});
		}

		return Ok(responseText);
	},
};

export type GroqCompletionService = typeof GroqCompletionServiceLive;
