import {
	type AnyTextAdapter,
	type UIMessage,
	chat,
	toServerSentEventsResponse,
} from '@tanstack/ai';
import { createAnthropicChat } from '@tanstack/ai-anthropic';
import { createGeminiChat } from '@tanstack/ai-gemini';
import { createGrokText } from '@tanstack/ai-grok';
import { createOpenaiChat } from '@tanstack/ai-openai';
import type { Context } from 'hono';
import { validator } from 'hono/validator';
import { defineErrors } from 'wellcrafted/error';
import type { Env } from './app';

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

const SUPPORTED_PROVIDERS = ['openai', 'anthropic', 'gemini', 'grok'] as const;
type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

function isSupportedProvider(value: string): value is SupportedProvider {
	return SUPPORTED_PROVIDERS.includes(value as SupportedProvider);
}

function getProviderApiKey(
	env: Env['Bindings'],
	provider: SupportedProvider,
): string | undefined {
	switch (provider) {
		case 'openai':
			return env.OPENAI_API_KEY;
		case 'anthropic':
			return env.ANTHROPIC_API_KEY;
		case 'gemini':
			return env.GEMINI_API_KEY;
		case 'grok':
			return env.GROK_API_KEY;
	}
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

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const AiChatError = defineErrors({
	UnsupportedProvider: ({ provider }: { provider: string }) => ({
		message: `Unsupported provider: ${provider}`,
		provider,
	}),
	ProviderNotConfigured: ({ provider }: { provider: string }) => ({
		message: `${provider} not configured`,
		provider,
	}),
});

// ---------------------------------------------------------------------------
// Validated request body
// ---------------------------------------------------------------------------

type AiChatBody = {
	messages: Array<UIMessage>;
	provider: SupportedProvider;
	model: string;
	systemPrompt: string | undefined;
};

/** Validates and normalizes the incoming JSON body before the handler runs. */
export const validateAiChat = validator('json', (value, c) => {
	if (typeof value !== 'object' || value === null) {
		return c.json({ error: 'Request body must be a JSON object' }, 400);
	}

	const body = value as Record<string, unknown>;
	const data = body.data as Record<string, unknown> | undefined;

	// --- messages ---
	const messages = body.messages;
	if (!Array.isArray(messages) || messages.length === 0) {
		return c.json({ error: 'Missing or empty messages' }, 400);
	}

	// --- provider ---
	const provider = data?.provider;
	if (typeof provider !== 'string' || !isSupportedProvider(provider)) {
		return c.json(
			AiChatError.UnsupportedProvider({
				provider: String(provider ?? 'undefined'),
			}),
			400,
		);
	}

	// --- model ---
	const model = data?.model;
	if (typeof model !== 'string' || model.length === 0) {
		return c.json({ error: 'Missing model' }, 400);
	}

	// --- systemPrompt (optional) ---
	const systemPrompt = data?.systemPrompt;
	if (systemPrompt !== undefined && typeof systemPrompt !== 'string') {
		return c.json({ error: 'systemPrompt must be a string' }, 400);
	}

	return {
		messages: messages as Array<UIMessage>,
		provider,
		model,
		systemPrompt,
	} satisfies AiChatBody;
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleAiChat(c: Context<Env>) {
	const { messages, provider, model, systemPrompt } =
		c.req.valid('json' as never) as AiChatBody;

	const apiKey = getProviderApiKey(c.env, provider);
	if (!apiKey) {
		return c.json(AiChatError.ProviderNotConfigured({ provider }), 503);
	}

	const adapter = createAdapter(provider, model, apiKey);
	const abortController = new AbortController();

	const stream = chat({
		adapter,
		// UIMessage[] from the client — chat() internally normalizes to
		// ModelMessage[] via convertMessagesToModelMessages.
		messages: messages as unknown as Parameters<typeof chat>[0]['messages'],
		systemPrompts: systemPrompt ? [systemPrompt] : [],
		abortController,
	});

	return toServerSentEventsResponse(stream, { abortController });
}
