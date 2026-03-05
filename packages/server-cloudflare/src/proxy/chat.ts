import {
	isSupportedProvider,
	PROVIDER_ENV_VARS,
	type SupportedProvider,
} from '@epicenter/sync-core';
import { factory } from '../hono';

/** Provider API chat completion endpoints. */
const PROVIDER_CHAT_URL: Record<SupportedProvider, string> = {
	openai: 'https://api.openai.com/v1/chat/completions',
	anthropic: 'https://api.anthropic.com/v1/messages',
	gemini: 'https://generativelanguage.googleapis.com/v1beta/chat/completions',
	grok: 'https://api.x.ai/v1/chat/completions',
};

/** Provider-specific auth header configuration. */
const PROVIDER_AUTH: Record<
	SupportedProvider,
	{ header: string; format: 'Bearer' | 'raw' }
> = {
	openai: { header: 'authorization', format: 'Bearer' },
	anthropic: { header: 'x-api-key', format: 'raw' },
	gemini: { header: 'authorization', format: 'Bearer' },
	grok: { header: 'authorization', format: 'Bearer' },
};

export function createAiChatHandler() {
	return factory.createHandlers(async (c) => {
		const body = await c.req.json<{
			provider?: string;
			model?: string;
			messages?: unknown[];
		}>();

		const provider = body.provider;
		if (!provider || !isSupportedProvider(provider)) {
			return c.json({ error: `Unsupported provider: ${provider}` }, 400);
		}

		const envKey = PROVIDER_ENV_VARS[provider];
		const apiKey = c.env[envKey] as string | undefined;
		if (!apiKey) {
			return c.json(
				{ error: `${provider} not configured (missing ${String(envKey)})` },
				503,
			);
		}

		const chatUrl = PROVIDER_CHAT_URL[provider];
		const authConfig = PROVIDER_AUTH[provider];
		const authValue =
			authConfig.format === 'Bearer' ? `Bearer ${apiKey}` : apiKey;

		const headers: Record<string, string> = {
			'content-type': 'application/json',
			[authConfig.header]: authValue,
		};

		// Anthropic requires the x-api-key header plus a version header
		if (provider === 'anthropic') {
			headers['anthropic-version'] = '2023-06-01';
		}

		const providerResponse = await fetch(chatUrl, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
		});

		// Stream the raw SSE response body through — don't re-parse.
		return new Response(providerResponse.body, {
			status: providerResponse.status,
			headers: {
				'content-type':
					providerResponse.headers.get('content-type') ?? 'text/event-stream',
			},
		});
	});
}
