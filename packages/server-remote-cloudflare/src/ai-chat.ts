import {
	isSupportedProvider,
	PROVIDER_ENV_VARS,
	type SupportedProvider,
} from '@epicenter/sync-core';
import {
	type AnyTextAdapter,
	chat,
	toServerSentEventsResponse,
} from '@tanstack/ai';
import { createAnthropicChat } from '@tanstack/ai-anthropic';
import { createGeminiChat } from '@tanstack/ai-gemini';
import { createGrokText } from '@tanstack/ai-grok';
import { createOpenaiChat } from '@tanstack/ai-openai';
import type { Context } from 'hono';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import type { Env } from './app';

const AiChatError = defineErrors({
	UnsupportedProvider: ({ provider }: { provider: string | undefined }) => ({
		message: `Unsupported provider: ${provider}`,
		provider,
	}),
	MissingModel: () => ({
		message: 'Missing model',
	}),
	MissingMessages: () => ({
		message: 'Missing or empty messages',
	}),
	ProviderNotConfigured: ({ provider }: { provider: string }) => ({
		message: `${provider} not configured`,
		provider,
	}),
});
type AiChatError = InferErrors<typeof AiChatError>;

interface AiChatRequestBody {
	messages: unknown[];
	data?: {
		provider?: string;
		model?: string;
		systemPrompt?: string;
	};
}

function getProviderApiKey(
	env: Env['Bindings'],
	provider: SupportedProvider,
): string | undefined {
	return env[PROVIDER_ENV_VARS[provider]];
}

/**
 * Create a TanStack AI text adapter for the given provider.
 *
 * Uses the `create*` factory variants that accept an explicit API key,
 * because Cloudflare Workers doesn't expose `process.env`.
 */
function createAdapter(
	provider: SupportedProvider,
	model: string,
	apiKey: string,
): AnyTextAdapter {
	const m = model as any;
	switch (provider) {
		case 'openai':
			return createOpenaiChat(m, apiKey);
		case 'anthropic':
			return createAnthropicChat(m, apiKey);
		case 'gemini':
			return createGeminiChat(m, apiKey);
		case 'grok':
			return createGrokText(m, apiKey);
	}
}

export async function handleAiChat(c: Context<Env>) {
	const { messages, data } = (await c.req.json()) as AiChatRequestBody;

	const provider = data?.provider;
	if (!provider || !isSupportedProvider(provider)) {
		return c.json(AiChatError.UnsupportedProvider({ provider }), 400);
	}

	const model = data?.model;
	if (!model) {
		return c.json(AiChatError.MissingModel(), 400);
	}

	if (!Array.isArray(messages) || messages.length === 0) {
		return c.json(AiChatError.MissingMessages(), 400);
	}

	const apiKey = getProviderApiKey(c.env, provider);
	if (!apiKey) {
		return c.json(AiChatError.ProviderNotConfigured({ provider }), 503);
	}

	const adapter = createAdapter(provider, model, apiKey);
	const abortController = new AbortController();
	const systemPrompts = data?.systemPrompt ? [data.systemPrompt] : [];

	const stream = chat({
		adapter,
		messages: messages as Parameters<typeof chat>[0]['messages'],
		systemPrompts,
		abortController,
	});

	return toServerSentEventsResponse(stream, { abortController });
}
