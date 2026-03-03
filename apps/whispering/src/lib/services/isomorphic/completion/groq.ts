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
			catch: (error): Err<CompletionError> => {
				if (error instanceof Groq.APIConnectionError) {
					return CompletionError.ConnectionFailed({ cause: error });
				}
				if (!(error instanceof Groq.APIError)) throw error;
				return CompletionError.Http({ status: error.status, cause: error });
			},
		});

		if (groqApiError) return Err(groqApiError);

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
