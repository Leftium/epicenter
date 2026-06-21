/**
 * The metered Epicenter backend: a vocab {@link ChatStream} the client answers
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
import type { ChatStream } from '@epicenter/workspace/ai';
import { VOCAB_MODEL, VOCAB_SYSTEM_PROMPT } from './vocab.js';

/**
 * Build the metered Epicenter {@link ChatStream} for one peer.
 *
 * @param sessionFetch the browser's authenticated fetch (`auth.fetch`), wrapped
 *   here for the AI-chat route.
 * @param baseURL the Epicenter API origin the SSE route lives under.
 */
export function epicenterMeteredChatStream(
	sessionFetch: AuthFetch,
	baseURL: string,
): ChatStream {
	return createEpicenterProviderChatStream({
		fetch: createAiChatFetch(sessionFetch),
		url: API_ROUTES.ai.chat.url(baseURL),
		data: () => ({
			model: VOCAB_MODEL,
			systemPrompts: [VOCAB_SYSTEM_PROMPT],
		}),
	});
}
