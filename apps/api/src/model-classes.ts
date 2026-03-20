export type ModelTier = 'ai_fast' | 'ai_standard' | 'ai_premium';

const MODEL_TIERS = {
	// OpenAI — fast (1 credit)
	'gpt-4o-mini': 'ai_fast',
	'gpt-4o-mini-2024-07-18': 'ai_fast',
	// OpenAI — standard (3 credits)
	'gpt-4o': 'ai_standard',
	'gpt-4o-2024-11-20': 'ai_standard',
	'o3-mini': 'ai_standard',
	// OpenAI — premium (10 credits)
	o1: 'ai_premium',
	o3: 'ai_premium',
	// Anthropic — fast (1 credit)
	'claude-3-5-haiku-latest': 'ai_fast',
	// Anthropic — standard (3 credits)
	'claude-sonnet-4-20250514': 'ai_standard',
	'claude-3-5-sonnet-latest': 'ai_standard',
	// Anthropic — premium (10 credits)
	'claude-opus-4-20250514': 'ai_premium',
} satisfies Record<string, ModelTier>;

/**
 * Map a TanStack AI model string to its Autumn feature ID (credit cost tier).
 *
 * Returns `undefined` for unknown models. Caller should decide whether to
 * block unknown models (safe default) or allow them at a default cost.
 */
export function getModelTier(model: string): ModelTier | undefined {
	return MODEL_TIERS[model];
}
