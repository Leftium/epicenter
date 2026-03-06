import { defineErrors, type InferErrors } from 'wellcrafted/error';

export const AuthError = defineErrors({
	Unauthorized: () => ({
		message: 'Unauthorized',
	}),
});
export type AuthError = InferErrors<typeof AuthError>;

export const AiChatError = defineErrors({
	UnsupportedProvider: ({ provider }: { provider: string | undefined }) => ({
		message: `Unsupported provider: ${provider}`,
		provider,
	}),
	MissingModel: () => ({
		message: 'Missing model',
	}),
	MissingMessages: () => ({
		message: 'Missing or empty messages',
	}),
	ProviderNotConfigured: ({ provider }: { provider: string }) => ({
		message: `${provider} not configured`,
		provider,
	}),
});
export type AiChatError = InferErrors<typeof AiChatError>;
