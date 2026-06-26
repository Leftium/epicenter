import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

export const CompletionError = defineErrors({
	/** HTTP-level failure from the provider API. Status preserved for callers that need it. */
	Http: ({ status, cause }: { status: number; cause: unknown }) => ({
		message: `Request failed (${status}): ${extractErrorMessage(cause)}`,
		status,
		cause,
	}),
	/** Network/DNS/TLS failure: never reached the server */
	ConnectionFailed: ({ cause }: { cause: unknown }) => ({
		message: `Connection failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
	/** Provider returned a successful response with no usable content */
	EmptyResponse: ({ providerLabel }: { providerLabel: string }) => ({
		message: `${providerLabel} API returned an empty response`,
		providerLabel,
	}),
});
export type CompletionError = InferErrors<typeof CompletionError>;

/**
 * A bespoke (non-wire) completion provider. The OpenAI-wire providers route
 * through `@epicenter/client`'s `complete()` and a `Connection`; this shape is for
 * the two that keep their own SDK clients (Anthropic, Google), so it carries no
 * `baseUrl`: a custom endpoint is a wire `Connection`, not a bespoke provider.
 */
export type CompletionService = {
	complete: (opts: {
		apiKey: string;
		model: string;
		systemPrompt: string;
		userPrompt: string;
	}) => Promise<Result<string, CompletionError>>;
};
