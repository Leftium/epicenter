import {
	isSupportedProvider,
	type SupportedProvider,
} from '@epicenter/sync-core';
import { factory } from '../hono';

const PROVIDER_CONFIG = {
	openai: {
		envKey: 'OPENAI_API_KEY',
		baseUrl: 'https://api.openai.com',
		authHeader: 'authorization',
		format: 'Bearer',
	},
	anthropic: {
		envKey: 'ANTHROPIC_API_KEY',
		baseUrl: 'https://api.anthropic.com',
		authHeader: 'x-api-key',
		format: 'raw',
	},
	gemini: {
		envKey: 'GEMINI_API_KEY',
		baseUrl: 'https://generativelanguage.googleapis.com',
		authHeader: 'authorization',
		format: 'Bearer',
	},
	grok: {
		envKey: 'GROK_API_KEY',
		baseUrl: 'https://api.x.ai',
		authHeader: 'authorization',
		format: 'Bearer',
	},
} as const satisfies Record<
	SupportedProvider,
	{
		envKey: string;
		baseUrl: string;
		authHeader: string;
		format: 'Bearer' | 'raw';
	}
>;

export function createProxyHandler() {
	return factory.createHandlers(async (c) => {
		const provider = c.req.param('provider') as string | undefined;
		if (!provider || !isSupportedProvider(provider)) {
			return c.json({ error: `Unknown provider: ${provider}` }, 400);
		}

		const config = PROVIDER_CONFIG[provider];
		const apiKey = c.env[config.envKey];
		if (!apiKey) {
			return c.json({ error: `${provider} not configured` }, 503);
		}

		// Build target URL: /proxy/openai/v1/chat/completions → https://api.openai.com/v1/chat/completions
		const subpath = c.req.path.replace(`/proxy/${provider}`, '');
		const targetUrl = `${config.baseUrl}${subpath}`;

		// Clone headers, replace session token with real API key
		const headers = new Headers(c.req.raw.headers);
		headers.delete('authorization');
		const value = config.format === 'Bearer' ? `Bearer ${apiKey}` : apiKey;
		headers.set(config.authHeader, value);

		const response = await fetch(targetUrl, {
			method: c.req.method,
			headers,
			body: c.req.raw.body,
		});

		// Stream response back (supports SSE from AI providers)
		return new Response(response.body, {
			status: response.status,
			headers: {
				'content-type':
					response.headers.get('content-type') ?? 'application/json',
			},
		});
	});
}
