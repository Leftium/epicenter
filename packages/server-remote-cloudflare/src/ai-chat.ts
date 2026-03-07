import { sValidator } from '@hono/standard-validator';
import {
	type AnyTextAdapter,
	chat,
	toServerSentEventsResponse,
} from '@tanstack/ai';
import { createAnthropicChat } from '@tanstack/ai-anthropic';
import { createOpenaiChat } from '@tanstack/ai-openai';
import { type } from 'arktype';
import { createFactory } from 'hono/factory';
import { defineErrors } from 'wellcrafted/error';
import type { Env } from './app';

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

const SUPPORTED_PROVIDERS = ['openai', 'anthropic'] as const;
type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

function getProviderApiKey(
	env: Env['Bindings'],
	provider: SupportedProvider,
): string | undefined {
	switch (provider) {
		case 'openai':
			return env.OPENAI_API_KEY;
		case 'anthropic':
			return env.ANTHROPIC_API_KEY;
	}
}

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
	}
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const AiChatError = defineErrors({
	ProviderNotConfigured: ({ provider }: { provider: string }) => ({
		message: `${provider} not configured`,
		provider,
	}),
});

// ---------------------------------------------------------------------------
// Validated request body & handler
// ---------------------------------------------------------------------------

const aiChatBody = type({
	messages: 'object[] >= 1',
	data: {
		provider: type.enumerated(...SUPPORTED_PROVIDERS),
		model: 'string >= 1',
		'systemPrompt?': 'string',
	},
});

const factory = createFactory<Env>();

export const aiChatHandlers = factory.createHandlers(
	sValidator('json', aiChatBody),
	async (c) => {
		const { messages, data } = c.req.valid('json');

		const apiKey = getProviderApiKey(c.env, data.provider);
		if (!apiKey) {
			return c.json(
				AiChatError.ProviderNotConfigured({ provider: data.provider }),
				503,
			);
		}

		const adapter = createAdapter(data.provider, data.model, apiKey);
		const abortController = new AbortController();

		const stream = chat({
			adapter,
			messages: messages as unknown as Parameters<typeof chat>[0]['messages'],
			systemPrompts: data.systemPrompt ? [data.systemPrompt] : [],
			abortController,
		});

		return toServerSentEventsResponse(stream, { abortController });
	},
);
