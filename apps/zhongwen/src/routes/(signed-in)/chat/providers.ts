/**
 * Provider and model configuration for Zhongwen chat.
 *
 * Reuses TanStack AI provider packages for model lists.
 */

import { GeminiTextModels } from '@tanstack/ai-gemini';
import { OPENAI_CHAT_MODELS } from '@tanstack/ai-openai';

// Only providers the `/api/ai/chat/doc` route can actually serve belong here:
// its `providerModel` validator accepts openai and gemini, so offering a third
// provider in the picker would persist a row the server rejects with a 400.
export const PROVIDER_MODELS = {
	openai: OPENAI_CHAT_MODELS,
	gemini: GeminiTextModels,
} as const;

export type Provider = keyof typeof PROVIDER_MODELS;

export const DEFAULT_PROVIDER = 'gemini' satisfies Provider;
type DefaultProviderModel =
	(typeof PROVIDER_MODELS)[typeof DEFAULT_PROVIDER][number];
export const DEFAULT_MODEL =
	'gemini-3.1-flash-lite-preview' satisfies DefaultProviderModel;
