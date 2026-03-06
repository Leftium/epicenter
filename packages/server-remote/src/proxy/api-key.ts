import type { SupportedProvider } from '@epicenter/sync-core';
import type { ApiKeyBindings } from '../types';

/** Statically resolve a provider's API key from the typed env bindings. */
export function getProviderApiKey(
	env: ApiKeyBindings,
	provider: SupportedProvider,
): string | undefined {
	const map = {
		openai: env.OPENAI_API_KEY,
		anthropic: env.ANTHROPIC_API_KEY,
		gemini: env.GEMINI_API_KEY,
		grok: env.GROK_API_KEY,
	} satisfies Record<SupportedProvider, string | undefined>;
	return map[provider];
}
