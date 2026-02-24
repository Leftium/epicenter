/**
 * BGSW adapter factory for AI chat.
 *
 * Creates TanStack AI text adapters configured for browser context.
 * Supports two modes:
 *
 * - **BYOK** (Bring Your Own Key): Direct to provider with `dangerouslyAllowBrowser: true`.
 *   The user's API key goes straight from the extension to the provider API.
 *
 * - **Operator proxy**: Uses `baseURL` pointing to the hub's `/proxy/:provider/*` endpoint.
 *   The hub validates the session token, injects the real API key from env vars,
 *   and forwards the request to the provider.
 *
 * @example
 * ```typescript
 * // BYOK mode — direct to provider
 * const adapter = createBgswAdapter('anthropic', 'claude-sonnet-4-20250514', {
 *   apiKey: 'sk-ant-...',
 * });
 *
 * // Operator proxy mode — via hub
 * const adapter = createBgswAdapter('anthropic', 'claude-sonnet-4-20250514', {
 *   apiKey: 'session-token',
 *   baseURL: 'https://hub.epicenter.so/proxy/anthropic',
 * });
 * ```
 */

import type { AnyTextAdapter } from '@tanstack/ai';
import {
	type AnthropicChatModel,
	createAnthropicChat,
} from '@tanstack/ai-anthropic';
import { createGeminiChat, type GeminiTextModel } from '@tanstack/ai-gemini';
import { createGrokText, type GrokChatModel } from '@tanstack/ai-grok';
import { createOpenaiChat, type OpenAIChatModel } from '@tanstack/ai-openai';

/**
 * Providers supported by the BGSW AI runtime.
 *
 * Mirrors the server's `SUPPORTED_PROVIDERS` — kept in sync manually.
 * Adding a provider here requires a matching case in `createBgswAdapter`.
 */
export const SUPPORTED_PROVIDERS = [
	'openai',
	'anthropic',
	'gemini',
	'grok',
] as const;

export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

/** Type guard for narrowing an arbitrary string to a known provider. */
export function isSupportedProvider(
	provider: string,
): provider is SupportedProvider {
	return SUPPORTED_PROVIDERS.includes(provider as SupportedProvider);
}

/**
 * Adapter creation options for the BGSW context.
 *
 * All adapters run in a browser extension service worker, so
 * `dangerouslyAllowBrowser` is always enabled for providers that require it.
 */
export type BgswAdapterOptions = {
	/** The API key (BYOK) or session token (proxy mode). */
	apiKey: string;
	/**
	 * Base URL override for proxying through the hub.
	 *
	 * When set, the adapter sends requests to this URL instead of the
	 * real provider API. The hub's `/proxy/:provider/*` endpoint validates
	 * the session token and injects the real API key.
	 *
	 * @example 'https://hub.epicenter.so/proxy/anthropic'
	 */
	baseURL?: string;
};

/**
 * Create a TanStack AI text adapter for the BGSW context.
 *
 * Always sets `dangerouslyAllowBrowser: true` since we're running in a
 * Chrome extension service worker. Optionally sets `baseURL` for
 * operator proxy mode.
 *
 * @returns The adapter instance, or `undefined` if the provider is not supported.
 */
export function createBgswAdapter(
	provider: string,
	model: string,
	options: BgswAdapterOptions,
): AnyTextAdapter | undefined {
	const { apiKey, baseURL } = options;

	// Config passed through to the underlying SDK client.
	// `dangerouslyAllowBrowser` is required for Anthropic/OpenAI SDKs in browser contexts.
	// `baseURL` overrides the default provider API endpoint for proxy mode.
	const sdkConfig = {
		dangerouslyAllowBrowser: true,
		...(baseURL ? { baseURL } : {}),
	};

	switch (provider) {
		case 'openai':
			return createOpenaiChat(model as OpenAIChatModel, apiKey, sdkConfig);
		case 'anthropic':
			return createAnthropicChat(
				model as AnthropicChatModel,
				apiKey,
				sdkConfig,
			);
		case 'gemini':
			return createGeminiChat(model as GeminiTextModel, apiKey, sdkConfig);
		case 'grok':
			return createGrokText(model as GrokChatModel, apiKey, sdkConfig);
		default:
			return undefined;
	}
}
