/**
 * Feature IDs matching the Autumn config.
 * Duplicated here to avoid importing from @epicenter/api (Cloudflare types).
 * These rarely change—they're part of the billing identity.
 */
export const FEATURE_IDS = {
	aiUsage: 'ai_usage',
	aiCredits: 'ai_credits',
} as const;
