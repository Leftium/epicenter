export type ModelClass = 'ai_chat_fast' | 'ai_chat_smart' | 'ai_chat_premium';

const MODEL_CLASSES: Record<string, ModelClass> = {
	// OpenAI — fast (1 credit)
	'gpt-4o-mini': 'ai_chat_fast',
	'gpt-4o-mini-2024-07-18': 'ai_chat_fast',
	// OpenAI — smart (3 credits)
	'gpt-4o': 'ai_chat_smart',
	'gpt-4o-2024-11-20': 'ai_chat_smart',
	'o3-mini': 'ai_chat_smart',
	// OpenAI — premium (10 credits)
	o1: 'ai_chat_premium',
	o3: 'ai_chat_premium',
	// Anthropic — fast (1 credit)
	'claude-3-5-haiku-latest': 'ai_chat_fast',
	// Anthropic — smart (3 credits)
	'claude-sonnet-4-20250514': 'ai_chat_smart',
	'claude-3-5-sonnet-latest': 'ai_chat_smart',
	// Anthropic — premium (10 credits)
	'claude-opus-4-20250514': 'ai_chat_premium',
};

/**
 * Map a TanStack AI model string to its Autumn feature ID (credit cost class).
 *
 * Returns `undefined` for unknown models. Caller should decide whether to
 * block unknown models (safe default) or allow them at a default cost.
 */
export function getModelClass(model: string): ModelClass | undefined {
	return MODEL_CLASSES[model];
}
