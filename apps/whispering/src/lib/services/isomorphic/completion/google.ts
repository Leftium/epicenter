import { GoogleGenerativeAI } from '@google/generative-ai';
import { Err, Ok, tryAsync } from 'wellcrafted/result';
import type { CompletionService } from './types';
import { CompletionError } from './types';

export const GoogleCompletionServiceLive: CompletionService = {
	complete: async ({ apiKey, model: modelName, systemPrompt, userPrompt }) => {
		const combinedPrompt = `${systemPrompt}\n${userPrompt}`;
		const { data: completion, error: completionError } = await tryAsync({
			try: async () => {
				const genAI = new GoogleGenerativeAI(apiKey);

				const model = genAI.getGenerativeModel({
					model: modelName,
					// TODO: Add temperature to step settings
					generationConfig: { temperature: 0 },
				});
				const { response } = await model.generateContent(combinedPrompt);
				return response.text();
			},
			catch: (error) =>
				CompletionError.Api({ cause: error }),
		});

		if (completionError) return Err(completionError);

		if (!completion) {
			return CompletionError.EmptyResponse({
				providerLabel: 'Google',
			});
		}

		return Ok(completion);
	},
};

export type GoogleCompletionService = typeof GoogleCompletionServiceLive;
