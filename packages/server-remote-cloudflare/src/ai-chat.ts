import { sValidator } from '@hono/standard-validator';
import {
	type AnyTextAdapter,
	chat,
	type ModelMessage,
	toServerSentEventsResponse,
} from '@tanstack/ai';
import { createAnthropicChat } from '@tanstack/ai-anthropic';
import { createOpenaiChat } from '@tanstack/ai-openai';
import { type } from 'arktype';
import { createFactory } from 'hono/factory';
import { defineErrors } from 'wellcrafted/error';
import type { Env } from './app';

const SUPPORTED_PROVIDERS = ['openai', 'anthropic'] as const;
type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

interface ProviderConfig {
	envKey: keyof Cloudflare.Env;
	createAdapter: (model: any, apiKey: string) => AnyTextAdapter;
}

const PROVIDERS: Record<SupportedProvider, ProviderConfig> = {
	openai: { envKey: 'OPENAI_API_KEY', createAdapter: createOpenaiChat },
	anthropic: { envKey: 'ANTHROPIC_API_KEY', createAdapter: createAnthropicChat },
};

const AiChatError = defineErrors({
	ProviderNotConfigured: ({ provider }: { provider: string }) => ({
		message: `${provider} not configured`,
		provider,
	}),
});

const aiChatBody = type({
	messages: 'object[] >= 1',
	data: {
		provider: type.enumerated(...SUPPORTED_PROVIDERS),
		model: 'string >= 1',
		'systemPrompts?': 'string[] | undefined',
		'temperature?': 'number | undefined',
		'maxTokens?': 'number | undefined',
		'topP?': 'number | undefined',
		'metadata?': 'Record<string, unknown> | undefined',
		'conversationId?': 'string | undefined',
	},
});

const factory = createFactory<Env>();

export const aiChatHandlers = factory.createHandlers(
	sValidator('json', aiChatBody),
	async (c) => {
		const { messages, data } = c.req.valid('json');
		const { provider, model, ...chatOptions } = data;

		const { envKey, createAdapter } = PROVIDERS[provider];
		const apiKey = c.env[envKey] as string | undefined;
		if (!apiKey) {
			return c.json(AiChatError.ProviderNotConfigured({ provider }), 503);
		}

		const abortController = new AbortController();
		const stream = chat({
			adapter: createAdapter(model, apiKey),
			messages: messages as Array<ModelMessage>,
			...chatOptions,
			abortController,
		});

		return toServerSentEventsResponse(stream, { abortController });
	},
);
