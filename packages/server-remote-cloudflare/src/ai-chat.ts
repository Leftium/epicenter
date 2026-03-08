import { sValidator } from '@hono/standard-validator';
import {
	type AnyTextAdapter,
	type ModelMessage,
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

const providers = {
	openai: {
		apiKeyBinding: 'OPENAI_API_KEY',
		createAdapter: createOpenaiChat,
	},
	anthropic: {
		apiKeyBinding: 'ANTHROPIC_API_KEY',
		createAdapter: createAnthropicChat,
	},
} as const satisfies Record<string, ProviderConfig>;

type StringBindingKey = {
	[K in keyof Cloudflare.Env]: Cloudflare.Env[K] extends string ? K : never;
}[keyof Cloudflare.Env];

type ProviderConfig = {
	apiKeyBinding: StringBindingKey;
	createAdapter: (model: any, apiKey: string) => AnyTextAdapter;
};

type SupportedProvider = keyof typeof providers;

const SUPPORTED_PROVIDERS = Object.keys(providers) as SupportedProvider[];

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

		const providerConfig: ProviderConfig = providers[provider];
		const apiKey = c.env[providerConfig.apiKeyBinding];
		if (!apiKey) {
			return c.json(
				AiChatError.ProviderNotConfigured({ provider }),
				503,
			);
		}

		const adapter = providerConfig.createAdapter(model as any, apiKey);
		const abortController = new AbortController();

		const stream = chat({
			adapter,
			messages: messages as Array<ModelMessage>,
			...chatOptions,
			abortController,
		});

		return toServerSentEventsResponse(stream, { abortController });
	},
);
