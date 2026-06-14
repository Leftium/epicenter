/**
 * The AI providers and models the hosted chat routes can serve.
 *
 * Single source of truth shared by the server validator and every client model
 * picker. The `packages/server` `/api/ai` validator enumerates each provider's
 * models from this map, with a compile-time assertion that it accepts every
 * provider listed here, and client pickers import it. So neither side
 * can offer or reject a provider, nor pair a provider with the wrong model
 * list, that the other does not (the mismatch that once shipped grok in the
 * pickers while the server rejected it with a 400).
 *
 * Model lists come from the TanStack AI provider packages; this is the one
 * place that pairs a provider with its list.
 */
import { GeminiTextModels } from '@tanstack/ai-gemini';
import { OPENAI_CHAT_MODELS } from '@tanstack/ai-openai';

export const SERVABLE_PROVIDERS = ['openai', 'gemini'] as const;

export const SERVABLE_PROVIDER_MODELS = {
	openai: OPENAI_CHAT_MODELS,
	gemini: GeminiTextModels,
} as const satisfies Record<
	(typeof SERVABLE_PROVIDERS)[number],
	readonly [string, ...string[]]
>;

export const SERVABLE_MODELS = [
	...OPENAI_CHAT_MODELS,
	...GeminiTextModels,
] as const;

export type ServableProvider = (typeof SERVABLE_PROVIDERS)[number];
export type ServableModel = (typeof SERVABLE_MODELS)[number];
