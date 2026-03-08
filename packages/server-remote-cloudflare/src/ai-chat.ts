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

function resolveProvider(
	env: Cloudflare.Env,
	provider: (typeof SUPPORTED_PROVIDERS)[number],
	model: string,
): { apiKey: string; adapter: AnyTextAdapter } | undefined {
	switch (provider) {
		case 'openai': {
			const apiKey = env.OPENAI_API_KEY;
			return apiKey
				? { apiKey, adapter: createOpenaiChat(model as any, apiKey) }
				: undefined;
		}
		case 'anthropic': {
			const apiKey = env.ANTHROPIC_API_KEY;
			return apiKey
				? { apiKey, adapter: createAnthropicChat(model as any, apiKey) }
				: undefined;
		}
	}
}

const factory = createFactory<Env>();

export const aiChatHandlers = factory.createHandlers(
	sValidator('json', aiChatBody),
	async (c) => {
		const { messages, data } = c.req.valid('json');
		const { provider, model, ...chatOptions } = data;

		const resolved = resolveProvider(c.env, provider, model);
		if (!resolved) {
			return c.json(AiChatError.ProviderNotConfigured({ provider }), 503);
		}

		const abortController = new AbortController();
		const stream = chat({
			adapter: resolved.adapter,
			messages: messages as Array<ModelMessage>,
			...chatOptions,
			abortController,
		});

		return toServerSentEventsResponse(stream, { abortController });
	},
);
