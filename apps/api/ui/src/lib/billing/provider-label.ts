import type { AiProvider } from '@epicenter/constants/ai-providers';

/**
 * Vendor display name for a provider id. The dashboard's single source of truth
 * for provider labels: both the cost guide and the activity feed render through
 * it, so the two tables can never disagree. Adding a provider to the catalog is
 * a compile error here until its label is supplied.
 */
export const PROVIDER_LABEL = {
	openai: 'OpenAI',
	gemini: 'Google',
} as const satisfies Record<AiProvider, string>;
