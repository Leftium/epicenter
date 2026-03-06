import { chat, toServerSentEventsResponse, type AnyTextAdapter } from '@tanstack/ai';
import { createAnthropicChat } from '@tanstack/ai-anthropic';
import { createGeminiChat } from '@tanstack/ai-gemini';
import { createGrokText } from '@tanstack/ai-grok';
import { createOpenaiChat } from '@tanstack/ai-openai';
import {
	isSupportedProvider,
	type SupportedProvider,
} from '@epicenter/sync-core';
import type { Context } from 'hono';
import type { ApiKeyBindings, Env } from './types';

function getProviderApiKey(
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
	// Model names arrive as dynamic strings from the client — cast to `any`
	// since the create* factories expect branded string literals.
	const m = model as any;
	let adapter: AnyTextAdapter;
	switch (provider) {
		case 'openai':
			adapter = createOpenaiChat(m, apiKey);
			break;
		case 'anthropic':
			adapter = createAnthropicChat(m, apiKey);
			break;
		case 'gemini':
			adapter = createGeminiChat(m, apiKey);
			break;
		case 'grok':
			adapter = createGrokText(m, apiKey);
			break;
	}
	return adapter;
}

export async function handleAiChat(c: Context<Env>) {
	const body = await c.req.json();
	const { messages, data } = body;

	const provider = data?.provider;
	if (!provider || !isSupportedProvider(provider)) {
		return c.json({ error: `Unsupported provider: ${provider}` }, 400);
	}

	const apiKey = getProviderApiKey(c.env, provider);
	if (!apiKey) {
		return c.json({ error: `${provider} not configured` }, 503);
	}

	const model = data?.model;
	const adapter = createAdapter(provider, model, apiKey);
	const abortController = new AbortController();

	const systemPrompts: string[] = data?.systemPrompt
		? [data.systemPrompt]
		: [];

	const stream = chat({
		adapter,
		messages,
		systemPrompts,
		abortController,
	});

	return toServerSentEventsResponse(stream, { abortController });
}
