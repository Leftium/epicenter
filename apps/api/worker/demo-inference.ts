/**
 * `POST /demo/v1/chat/completions`: anonymous, budget-capped text generation
 * for the Zhongwen tutor demo. A client points an OpenAI SDK at
 * `https://api.epicenter.so/demo/v1` with any placeholder key.
 *
 * This is a temporary path that needs no account, so it touches no Postgres,
 * Better Auth, or Autumn. What bounds the house key's spend instead:
 *
 *   - One request shape: `zhongwen-tutor`, `stream: true`, and text-only
 *     system/user/assistant messages. Any other field (tools, images, audio,
 *     `n`, a provider key) is rejected, not dropped, and the upstream body is
 *     rebuilt from the validated fields with a fixed output cap.
 *   - Size limits checked before anything is spent: a 64 KiB body counted as
 *     it streams in, non-empty messages, and 16,000 characters of message text.
 *   - A global attempt budget held by one Durable Object
 *     (`DemoGenerationBudget`), consumed before the provider is called.
 *
 * The ordinary `/v1/chat/completions` gateway is unchanged and still requires a
 * session bearer. CORS for this route comes from the global trusted-origin
 * list; it is a browser courtesy, not authorization.
 *
 * Validation and failures before streaming answer the gateway's OpenAI error envelope,
 * `{ error: { message, code } }`, with a fixed message. Provider error bodies,
 * provider URLs, and the key are not returned for those failures. Successful
 * SSE bodies pass through unchanged, including any midstream error frames.
 * Nothing here logs a prompt.
 */

import type { Env } from '@epicenter/server';
import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { describeRoute } from 'hono-openapi';
import type { DemoBudgetDecision } from './demo-budget.js';

export const DEMO_COMPLETIONS_PATH = '/demo/v1/chat/completions';
export const DEMO_MODEL = 'zhongwen-tutor';

export const DEMO_LIMITS = {
	maxBodyBytes: 64 * 1024,
	/** Summed over every message, in UTF-16 code units (`String.length`). */
	maxContentChars: 16_000,
	maxCompletionTokens: 2048,
	providerTimeoutMs: 90_000,
	budgetTimeoutMs: 5_000,
} as const;

// The library gateway keeps its provider table private; this one URL is the
// only routing fact this route needs.
const GEMINI_COMPLETIONS_URL =
	'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

const ALLOWED_FIELDS = new Set(['model', 'messages', 'stream']);
const ALLOWED_ROLES = new Set(['system', 'user', 'assistant']);

type DemoMessage = {
	role: 'system' | 'user' | 'assistant';
	content: string;
};

function openAiError(message: string, code: string) {
	return { error: { message, code } };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
	return Object.keys(value).every((key) => keys.includes(key));
}

/**
 * Read at most `maxBytes` of the body, counting bytes as they arrive so a
 * missing or wrong Content-Length cannot get a larger body buffered.
 */
async function readBoundedBody(
	request: Request,
	maxBytes: number,
): Promise<Uint8Array | 'too_large'> {
	const declared = Number(request.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > maxBytes) return 'too_large';
	if (!request.body) return new Uint8Array();

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > maxBytes) {
			await reader.cancel().catch(() => {});
			return 'too_large';
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

/** Strict UTF-8 JSON, or `null`; invalid bytes are refused, not replaced. */
function parseJson(bytes: Uint8Array): unknown {
	try {
		return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
	} catch {
		return null;
	}
}

/**
 * Validate the demo request and return the messages to forward, or the reason
 * it is refused. Only fields read here are ever sent upstream.
 */
function parseDemoRequest(
	raw: unknown,
): { ok: true; messages: DemoMessage[] } | { ok: false; message: string } {
	if (!isPlainObject(raw)) {
		return { ok: false, message: 'The body must be a JSON object.' };
	}
	const unknownField = Object.keys(raw).find((key) => !ALLOWED_FIELDS.has(key));
	if (unknownField !== undefined) {
		return { ok: false, message: `Unsupported field: ${unknownField}.` };
	}
	if (raw.model !== DEMO_MODEL) {
		return { ok: false, message: `model must be ${DEMO_MODEL}.` };
	}
	if (raw.stream !== true) {
		return { ok: false, message: 'stream must be true.' };
	}
	const { messages } = raw;
	if (!Array.isArray(messages) || messages.length === 0) {
		return {
			ok: false,
			message: 'messages must be a non-empty array.',
		};
	}

	const normalized: DemoMessage[] = [];
	let chars = 0;
	for (const message of messages) {
		if (
			!isPlainObject(message) ||
			!hasOnlyKeys(message, ['role', 'content']) ||
			typeof message.role !== 'string' ||
			!ALLOWED_ROLES.has(message.role)
		) {
			return {
				ok: false,
				message:
					'Each message must be a system, user, or assistant message with only role and content.',
			};
		}
		const { content } = message;
		if (typeof content !== 'string')
			return { ok: false, message: 'Message content must be a string.' };
		chars += content.length;
		normalized.push({
			role: message.role as DemoMessage['role'],
			content,
		});
	}
	if (chars > DEMO_LIMITS.maxContentChars) {
		return {
			ok: false,
			message:
				'This conversation is too long for the demo. Start a new practice. Your saved messages remain available.',
		};
	}
	return { ok: true, messages: normalized };
}

/** Reject after `ms`, so a stuck budget call fails closed instead of hanging. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error('timed out')), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Mount the anonymous demo completions route.
 *
 * `consumeAttempt` spends one attempt from the shared budget. The deployment
 * supplies it so the route stays free of Durable Object bindings; any throw or
 * timeout is treated as "budget unavailable" and refuses the request.
 */
export function mountDemoInference<E extends Env = Env>(
	app: Hono<E>,
	opts: {
		resolveModel: (c: Context<E>) => string | undefined;
		consumeAttempt: (c: Context<E>) => Promise<DemoBudgetDecision>;
	},
): void {
	app.post(
		DEMO_COMPLETIONS_PATH,
		describeRoute({
			description:
				'Anonymous, budget-capped Chat Completions for the Zhongwen demo',
			tags: ['ai'],
		}),
		async (c: Context<E>) => {
			const fail = (
				status: ContentfulStatusCode,
				message: string,
				code: string,
			) => c.json(openAiError(message, code), status);

			const bytes = await readBoundedBody(
				c.req.raw,
				DEMO_LIMITS.maxBodyBytes,
			).catch(() => null);
			if (bytes === 'too_large') {
				return fail(413, 'Request body is too large.', 'request_too_large');
			}
			const parsed = parseDemoRequest(bytes ? parseJson(bytes) : null);
			if (!parsed.ok) return fail(400, parsed.message, 'invalid_request');

			const apiKey = c.env.GEMINI_API_KEY;
			const model = opts.resolveModel(c)?.trim();
			if (!apiKey || !model) {
				return fail(
					503,
					'Demo generation is not configured.',
					'ProviderNotConfigured',
				);
			}

			let decision: DemoBudgetDecision;
			try {
				decision = await withTimeout(
					opts.consumeAttempt(c),
					DEMO_LIMITS.budgetTimeoutMs,
				);
			} catch {
				return fail(503, 'Demo generation is unavailable.', 'demo_unavailable');
			}
			if (!decision.allowed) {
				c.header('retry-after', String(decision.retryAfterSeconds));
				// Not CORS-safelisted, so a browser client cannot read it unless exposed.
				c.header('access-control-expose-headers', 'Retry-After', {
					append: true,
				});
				return fail(
					429,
					'The demo is at capacity. Try again later.',
					'rate_limit_exceeded',
				);
			}

			const timeout = AbortSignal.timeout(DEMO_LIMITS.providerTimeoutMs);
			let upstream: Response;
			try {
				upstream = await fetch(GEMINI_COMPLETIONS_URL, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						authorization: `Bearer ${apiKey}`,
					},
					body: JSON.stringify({
						model,
						// Gemini requires contents even when the tutor opens before any
						// learner turn. Preserve the instructions without inventing text.
						messages: parsed.messages.every(({ role }) => role === 'system')
							? parsed.messages.map((message) => ({ ...message, role: 'user' }))
							: parsed.messages,
						stream: true,
						n: 1,
						// Short tutor replies should start without the default medium thinking.
						reasoning_effort: 'minimal',
						max_completion_tokens: DEMO_LIMITS.maxCompletionTokens,
					}),
					// Client disconnect (enable_request_signal) or the deadline
					// cancels the provider call, including its streamed body.
					signal: AbortSignal.any([c.req.raw.signal, timeout]),
				});
			} catch {
				return timeout.aborted
					? fail(504, 'The model took too long to respond.', 'upstream_timeout')
					: fail(
							502,
							'The model provider could not be reached.',
							'upstream_unreachable',
						);
			}

			if (!upstream.ok || !upstream.body) {
				await upstream.body?.cancel().catch(() => {});
				return fail(
					502,
					'The model provider returned an error.',
					'upstream_error',
				);
			}

			return new Response(upstream.body, {
				status: 200,
				headers: {
					'content-type': 'text/event-stream',
					'cache-control': 'no-cache',
				},
			});
		},
	);
}
