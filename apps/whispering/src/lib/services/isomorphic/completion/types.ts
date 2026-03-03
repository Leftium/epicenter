import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

export const CompletionError = defineErrors({
	BadRequest: ({ cause }: { cause: unknown }) => ({
		message: `Invalid request: ${extractErrorMessage(cause)}`,
		cause,
	}),
	Unauthorized: ({ cause }: { cause: unknown }) => ({
		message: `Authentication failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
	Forbidden: ({ cause }: { cause: unknown }) => ({
		message: `Access denied: ${extractErrorMessage(cause)}`,
		cause,
	}),
	ModelNotFound: ({ cause }: { cause: unknown }) => ({
		message: `Model not found: ${extractErrorMessage(cause)}`,
		cause,
	}),
	UnprocessableEntity: ({ cause }: { cause: unknown }) => ({
		message: `Unprocessable request: ${extractErrorMessage(cause)}`,
		cause,
	}),
	RateLimit: ({ cause }: { cause: unknown }) => ({
		message: `Rate limit exceeded: ${extractErrorMessage(cause)}`,
		cause,
	}),
	ServerError: ({ cause }: { cause: unknown }) => ({
		message: `Server error: ${extractErrorMessage(cause)}`,
		cause,
	}),
	ConnectionFailed: ({ cause }: { cause: unknown }) => ({
		message: `Connection failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
	EmptyResponse: ({ providerLabel }: { providerLabel: string }) => ({
		message: `${providerLabel} API returned an empty response`,
		providerLabel,
	}),
	MissingParam: ({ param }: { param: string }) => ({
		message: `${param} is required`,
		param,
	}),
	Api: ({ cause }: { cause: unknown }) => ({
		message: `API error: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type CompletionError = InferErrors<typeof CompletionError>;

export type CompletionService = {
	complete: (opts: {
		apiKey: string;
		model: string;
		systemPrompt: string;
		userPrompt: string;
		/** Optional base URL for custom/self-hosted endpoints (Ollama, LM Studio, etc.) */
		baseUrl?: string;
	}) => Promise<Result<string, CompletionError>>;
};
