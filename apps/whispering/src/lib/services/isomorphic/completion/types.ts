import { defineErrors, type InferErrors } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

export const CompletionError = defineErrors({
	Service: ({ message }: { message: string }) => ({ message }),
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
