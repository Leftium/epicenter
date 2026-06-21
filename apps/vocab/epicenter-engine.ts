/**
 * The metered Epicenter backend: a {@link VocabChatStream} the client answers
 * with over the `/api/ai/chat` SSE stream on the user's Epicenter account (the
 * Epicenter provider, ADR-0033). The wire shape (the AI-chat fetch wrapper, the
 * route, the `model` + `systemPrompts` body) is single-homed here instead of
 * inlined at the call site.
 *
 * It lives outside the dep-free contract (`vocab.ts`) on purpose: it pulls in
 * `@epicenter/client`, so it is its own subpath (`@epicenter/vocab/engine`),
 * built from the browser's session fetch and base URL.
 */

import type { AuthFetch } from '@epicenter/auth';
import {
	createAiChatFetch,
	createEpicenterProviderChatStream,
} from '@epicenter/client';
import { API_ROUTES } from '@epicenter/constants/api-routes';
import type { ModelMessage, StreamChunk } from '@tanstack/ai';
import { VOCAB_MODEL, VOCAB_SYSTEM_PROMPT } from './vocab.js';

/**
 * The inference contract the vocab client consumes: a snapshotted prompt and an
 * abort signal in, an async stream of text-delta (and error) chunks out. This is
 * structurally what `createEpicenterProviderChatStream` returns; naming it here
 * lets the engine and the conversation controller share one import.
 */
export type VocabChatStream = (
	messages: ModelMessage[],
	signal: AbortSignal,
) => AsyncIterable<StreamChunk>;

/**
 * Build the metered Epicenter {@link VocabChatStream} the browser answers with.
 *
 * @param sessionFetch the browser's authenticated fetch (`auth.fetch`), wrapped
 *   here for the AI-chat route.
 * @param baseURL the Epicenter API origin the SSE route lives under.
 */
export function epicenterMeteredChatStream(
	sessionFetch: AuthFetch,
	baseURL: string,
): VocabChatStream {
	return createEpicenterProviderChatStream({
		fetch: createAiChatFetch(sessionFetch),
		url: API_ROUTES.ai.chat.url(baseURL),
		data: () => ({
			model: VOCAB_MODEL,
			systemPrompts: [VOCAB_SYSTEM_PROMPT],
		}),
	});
}
