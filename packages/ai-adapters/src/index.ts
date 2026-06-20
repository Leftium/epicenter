import {
	MODELS_BY_ID,
	type ServableModel,
} from '@epicenter/constants/ai-providers';
import type { AnyTextAdapter } from '@tanstack/ai';
import { createGeminiChat } from '@tanstack/ai-gemini';
import { createOpenaiChat } from '@tanstack/ai-openai';

/**
 * Construct the TanStack text adapter for an Epicenter model id. This is the
 * executable twin of the model catalog (`MODELS_BY_ID`): the catalog owns the
 * model -> provider data, this owns turning that data into a live adapter. The
 * discriminated switch narrows `entry.id` to each SDK's model union, so the
 * construction calls are typed with no cast.
 *
 * The body is only the provider switch: no key policy, no `Result`. The caller
 * owns where the key comes from (BYOK vs house) and what an absent key means;
 * see `resolveAdapter` in `@epicenter/server` and `resolveChatStream` in the
 * zhongwen daemon.
 */
export function createAdapterForModel(
	model: ServableModel,
	apiKey: string,
): AnyTextAdapter {
	const entry = MODELS_BY_ID[model];
	switch (entry.provider) {
		case 'openai':
			return createOpenaiChat(entry.id, apiKey);
		case 'gemini':
			return createGeminiChat(entry.id, apiKey);
		default:
			return entry satisfies never;
	}
}
