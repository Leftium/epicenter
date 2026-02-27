import { SUPPORTED_PROVIDERS, type SupportedProvider } from '@epicenter/server';

/**
 * Provider API base URLs for the hub proxy.
 *
 * Maps each supported provider to its proxy path on the hub server.
 * OpenCode calls `{hubUrl}/proxy/{provider}` instead of the real
 * provider API, and the hub injects the real API key on the way through.
 */
function proxyBaseUrl(hubUrl: string, provider: SupportedProvider): string {
	return `${hubUrl}/proxy/${provider}`;
}

/**
 * OpenCode provider configuration for a single provider.
 *
 * The `apiKey` field carries the session token (not a real API key).
 * The hub proxy validates this token and swaps it for the real key.
 * The `baseURL` points to the hub's proxy endpoint for this provider.
 */
type ProviderConfig = {
	options: {
		apiKey: string;
		baseURL: string;
	};
};

/**
 * OpenCode configuration content structure.
 *
 * Matches the shape expected by `OPENCODE_CONFIG_CONTENT` env var.
 * OpenCode reads this at startup to configure its provider connections.
 *
 * @see https://opencode.ai/docs/ — OpenCode config format
 */
export type OpenCodeConfig = {
	provider: Record<string, ProviderConfig>;
};

export type GenerateConfigOptions = {
	/**
	 * Hub server URL (e.g., `http://localhost:3913` or `https://hub.epicenter.so`).
	 *
	 * Each provider's `baseURL` will be set to `{hubUrl}/proxy/{provider}`,
	 * routing all LLM requests through the hub's proxy.
	 */
	hubUrl: string;

	/**
	 * Better Auth session token.
	 *
	 * Injected as the `apiKey` for every provider. The hub proxy validates
	 * this token and swaps it for the real API key before forwarding.
	 * Keys never leave the hub.
	 */
	sessionToken: string;

	/**
	 * Providers to configure.
	 *
	 * Defaults to all supported providers (`SUPPORTED_PROVIDERS`).
	 * Pass a subset to limit which providers OpenCode can use.
	 */
	providers?: SupportedProvider[];
};

/**
 * Generate the OpenCode configuration object for hub proxy routing.
 *
 * Creates a config where every provider's `baseURL` points to the hub's
 * reverse proxy (`{hubUrl}/proxy/{provider}`) and every provider's `apiKey`
 * is the session token. The hub validates the token, resolves the real API
 * key from the environment variable, and forwards the request to the real
 * provider API.
 *
 * @example
 * ```typescript
 * const config = generateOpenCodeConfig({
 *   hubUrl: 'http://localhost:3913',
 *   sessionToken: 'ses_abc123...',
 * });
 *
 * // Result:
 * // {
 * //   provider: {
 * //     openai:    { options: { apiKey: 'ses_abc123...', baseURL: 'http://localhost:3913/proxy/openai' } },
 * //     anthropic: { options: { apiKey: 'ses_abc123...', baseURL: 'http://localhost:3913/proxy/anthropic' } },
 * //     gemini:    { options: { apiKey: 'ses_abc123...', baseURL: 'http://localhost:3913/proxy/gemini' } },
 * //     grok:      { options: { apiKey: 'ses_abc123...', baseURL: 'http://localhost:3913/proxy/grok' } },
 * //   },
 * // }
 * ```
 */
export function generateOpenCodeConfig(
	options: GenerateConfigOptions,
): OpenCodeConfig {
	const { hubUrl, sessionToken, providers = SUPPORTED_PROVIDERS } = options;

	const providerEntries: Record<string, ProviderConfig> = {};

	for (const provider of providers) {
		providerEntries[provider] = {
			options: {
				apiKey: sessionToken,
				baseURL: proxyBaseUrl(hubUrl, provider),
			},
		};
	}

	return { provider: providerEntries };
}

/**
 * Generate the JSON string for the `OPENCODE_CONFIG_CONTENT` env var.
 *
 * Convenience wrapper around `generateOpenCodeConfig` that serializes
 * the result to a JSON string suitable for injection via environment
 * variable at spawn time.
 *
 * @example
 * ```typescript
 * const configJson = generateOpenCodeConfigContent({
 *   hubUrl: 'http://localhost:3913',
 *   sessionToken: 'ses_abc123...',
 * });
 *
 * // Pass to OpenCode process:
 * Bun.spawn(['opencode', 'serve'], {
 *   env: { ...process.env, OPENCODE_CONFIG_CONTENT: configJson },
 * });
 * ```
 */
export function generateOpenCodeConfigContent(
	options: GenerateConfigOptions,
): string {
	return JSON.stringify(generateOpenCodeConfig(options));
}
