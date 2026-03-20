export type ModelClass = 'ai-chat-fast' | 'ai-chat-smart' | 'ai-chat-premium';

const MODEL_CLASSES: Record<string, ModelClass> = {
	// OpenAI — fast (1 credit)
	'gpt-4o-mini': 'ai-chat-fast',
	'gpt-4o-mini-2024-07-18': 'ai-chat-fast',
	// OpenAI — smart (3 credits)
	'gpt-4o': 'ai-chat-smart',
	'gpt-4o-2024-11-20': 'ai-chat-smart',
	'o3-mini': 'ai-chat-smart',
	// OpenAI — premium (10 credits)
	o1: 'ai-chat-premium',
	o3: 'ai-chat-premium',
	// Anthropic — fast (1 credit)
	'claude-3-5-haiku-latest': 'ai-chat-fast',
	// Anthropic — smart (3 credits)
	'claude-sonnet-4-20250514': 'ai-chat-smart',
	'claude-3-5-sonnet-latest': 'ai-chat-smart',
	// Anthropic — premium (10 credits)
	'claude-opus-4-20250514': 'ai-chat-premium',
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
