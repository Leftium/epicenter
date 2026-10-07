/**
 * The anonymous demo route, driven through the real Worker entry.
 *
 * The provider is a stubbed global `fetch` (no network), and the budget binding
 * is a fake namespace whose stub is the real `DemoGenerationBudget` over
 * `bun:sqlite`. `HYPERDRIVE` is a getter that counts reads and throws, so any
 * database use on the demo path shows up as a count and a failure.
 */

import { Database } from 'bun:sqlite';
import {
	afterAll,
	beforeEach,
	expect,
	mock,
	setSystemTime,
	spyOn,
	test,
} from 'bun:test';
import { APPS } from '@epicenter/constants/apps';

// The Worker entry re-exports Durable Objects whose modules import
// `cloudflare:workers`. Only the class identity matters here.
mock.module('cloudflare:workers', () => ({ DurableObject: class {} }));

const entry = await import('./index.js');
const { DEMO_BUDGET, DEMO_BUDGET_OBJECT_NAME, DemoGenerationBudget } =
	await import('./demo-budget.js');
const { DEMO_LIMITS, DEMO_MODEL } = await import('./demo-inference.js');
type DemoBudgetDecision = import('./demo-budget.js').DemoBudgetDecision;

const ORIGIN = 'http://localhost:8787';
const DEMO_URL = `${ORIGIN}/demo/v1/chat/completions`;
const GEMINI_KEY = 'test-gemini-house-key';
const SSE =
	'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n';

function sqliteStorage(db: Database) {
	return {
		sql: {
			exec: (query: string, ...bindings: (string | number)[]) =>
				db.query(query).all(...bindings) as Record<string, string | number>[],
		},
		transactionSync: <T>(closure: () => T) => db.transaction(closure)(),
	};
}

// --- Provider stub -------------------------------------------------------

type ProviderCall = { url: string; init: RequestInit };
let providerCalls: ProviderCall[] = [];
let provider: (call: ProviderCall) => Response | Promise<Response>;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (
	input: RequestInfo | URL,
	init: RequestInit = {},
) => {
	const call = { url: String(input), init };
	providerCalls.push(call);
	return provider(call);
}) as typeof fetch;
afterAll(() => {
	globalThis.fetch = realFetch;
	setSystemTime();
});

// --- Worker env ----------------------------------------------------------

let db: Database;
let budgetNames: string[];
let hyperdriveReads = 0;

function budgetCount(): number {
	const row = db
		.query("SELECT count FROM _demo_budget_windows WHERE scope = 'day'")
		.get() as { count: number } | null;
	return row?.count ?? 0;
}

function budgetNamespace(consume?: () => Promise<DemoBudgetDecision>) {
	const object = new DemoGenerationBudget(
		{ storage: sqliteStorage(db) } as unknown as DurableObjectState,
		{} as Cloudflare.Env,
	);
	return {
		idFromName: (name: string) => {
			budgetNames.push(name);
			return { name };
		},
		get: () => ({
			consume: consume ?? (async () => object.consume()),
		}),
	};
}

function workerEnv(overrides: Record<string, unknown> = {}) {
	return {
		API_PUBLIC_ORIGIN: ORIGIN,
		BETTER_AUTH_SECRET: 'demo-inference-test-secret-not-a-real-key',
		GEMINI_API_KEY: GEMINI_KEY,
		get HYPERDRIVE() {
			hyperdriveReads++;
			throw new Error('the demo route must not touch Postgres');
		},
		DEMO_GENERATION_BUDGET: budgetNamespace(),
		...overrides,
	};
}

function call(request: Request, env: object = workerEnv()) {
	const executionCtx = { waitUntil() {}, passThroughOnException() {} };
	return entry.default.fetch(request, env as never, executionCtx as never);
}

function demoRequest(body: unknown, init: RequestInit = {}): Request {
	return new Request(DEMO_URL, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: typeof body === 'string' ? body : JSON.stringify(body),
		...init,
	});
}

const validBody = {
	model: DEMO_MODEL,
	stream: true,
	messages: [
		{ role: 'system', content: 'You are a Mandarin tutor.' },
		{ role: 'user', content: '你好' },
	],
};

beforeEach(() => {
	// Pinned so a cap test never straddles a minute boundary.
	setSystemTime(new Date(Date.UTC(2026, 9, 7, 12, 30, 15)));
	db = new Database(':memory:');
	budgetNames = [];
	providerCalls = [];
	hyperdriveReads = 0;
	provider = () =>
		new Response(SSE, { headers: { 'content-type': 'text/event-stream' } });
});

// --- Tests ---------------------------------------------------------------

test('a valid request streams the provider bytes back over the OpenAI wire', async () => {
	const env = workerEnv();
	const response = await call(
		demoRequest(validBody, {
			headers: {
				'content-type': 'application/json',
				// What an OpenAI SDK sends with a placeholder key; never forwarded.
				authorization: 'Bearer sk-client-placeholder',
				origin: APPS.ZHONGWEN.url,
			},
		}),
		env,
	);

	expect(response.status).toBe(200);
	expect(response.headers.get('content-type')).toBe('text/event-stream');
	expect(response.headers.get('access-control-allow-origin')).toBe(
		APPS.ZHONGWEN.url,
	);
	expect(await response.text()).toBe(SSE);

	expect(providerCalls).toHaveLength(1);
	const { url, init } = providerCalls[0] as ProviderCall;
	expect(url).toBe(
		'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
	);
	expect(new Headers(init.headers).get('authorization')).toBe(
		`Bearer ${GEMINI_KEY}`,
	);
	expect(JSON.parse(String(init.body))).toEqual({
		model: DEMO_MODEL,
		messages: validBody.messages,
		stream: true,
		n: 1,
		reasoning_effort: 'minimal',
		max_completion_tokens: 2048,
	});
	expect(budgetNames).toEqual([DEMO_BUDGET_OBJECT_NAME]);
	expect(budgetCount()).toBe(1);
	expect(hyperdriveReads).toBe(0);
});

const tooManyChars = [
	{ role: 'user', content: 'a'.repeat(DEMO_LIMITS.maxContentChars - 10) },
	{ role: 'assistant', content: 'b'.repeat(11) },
];

const invalidBodies: [string, unknown][] = [
	[
		'tools',
		{ ...validBody, tools: [{ type: 'function', function: { name: 'x' } }] },
	],
	['functions', { ...validBody, functions: [{ name: 'x' }] }],
	['tool_choice', { ...validBody, tool_choice: 'auto' }],
	['n', { ...validBody, n: 8 }],
	['max_completion_tokens', { ...validBody, max_completion_tokens: 100_000 }],
	['client api key', { ...validBody, api_key: 'sk-user' }],
	['modalities', { ...validBody, modalities: ['text', 'audio'] }],
	['audio', { ...validBody, audio: { voice: 'alloy', format: 'wav' } }],
	['other model', { ...validBody, model: 'gpt-5' }],
	['stream false', { ...validBody, stream: false }],
	['stream missing', { model: DEMO_MODEL, messages: validBody.messages }],
	['other reasoning effort', { ...validBody, reasoning_effort: 'high' }],
	['no messages', { ...validBody, messages: [] }],
	['too many characters', { ...validBody, messages: tooManyChars }],
	[
		'tool role',
		{
			...validBody,
			messages: [{ role: 'tool', content: 'x', tool_call_id: 'a' }],
		},
	],
	[
		'developer role',
		{ ...validBody, messages: [{ role: 'developer', content: 'x' }] },
	],
	[
		'message tool_calls',
		{
			...validBody,
			messages: [{ role: 'assistant', content: 'x', tool_calls: [] }],
		},
	],
	[
		'message name',
		{ ...validBody, messages: [{ role: 'user', content: 'x', name: 'n' }] },
	],
	[
		'null content',
		{ ...validBody, messages: [{ role: 'assistant', content: null }] },
	],
	[
		'image part',
		{
			...validBody,
			messages: [
				{
					role: 'user',
					content: [{ type: 'image_url', image_url: { url: 'https://x' } }],
				},
			],
		},
	],
	[
		'input_audio part',
		{
			...validBody,
			messages: [
				{
					role: 'user',
					content: [
						{ type: 'input_audio', input_audio: { data: 'x', format: 'wav' } },
					],
				},
			],
		},
	],
	[
		'extra key on text part',
		{
			...validBody,
			messages: [
				{
					role: 'user',
					content: [{ type: 'text', text: 'x', cache_control: {} }],
				},
			],
		},
	],
	['array body', [validBody]],
	['malformed JSON', '{"model":'],
	['empty body', ''],
];

test.each(
	invalidBodies,
)('rejects %s before spending budget or calling the provider', async (_, body) => {
	const response = await call(demoRequest(body));
	expect(response.status).toBe(400);
	expect(await response.json()).toMatchObject({
		error: { code: 'invalid_request' },
	});
	expect(budgetNames).toEqual([]);
	expect(budgetCount()).toBe(0);
	expect(providerCalls).toHaveLength(0);
});

test('rejects invalid UTF-8 before spending budget', async () => {
	const json = new TextEncoder().encode(JSON.stringify(validBody));
	// Swap the 你 bytes for invalid UTF-8; a lenient decoder would forward U+FFFD.
	const bytes = new Uint8Array(json);
	const at = bytes.indexOf(0xe4);
	bytes.set([0xff, 0xfe, 0xfd], at);
	const response = await call(
		new Request(DEMO_URL, { method: 'POST', body: bytes }),
	);
	expect(response.status).toBe(400);
	expect(budgetNames).toEqual([]);
	expect(providerCalls).toHaveLength(0);
});

test('an oversized body is refused by its declared length and by its streamed bytes', async () => {
	const padding = 'x'.repeat(DEMO_LIMITS.maxBodyBytes);
	const declared = demoRequest({ ...validBody, padding });
	expect((await call(declared)).status).toBe(413);

	// No Content-Length: the body arrives in chunks and is counted as it streams.
	const chunk = new TextEncoder().encode('x'.repeat(16 * 1024));
	let pulled = 0;
	const streamed = new Request(DEMO_URL, {
		method: 'POST',
		body: new ReadableStream({
			pull(controller) {
				pulled++;
				if (pulled > 100) controller.close();
				else controller.enqueue(chunk);
			},
		}),
		// @ts-expect-error Bun's RequestInit accepts duplex for streamed bodies
		duplex: 'half',
	});
	expect(streamed.headers.get('content-length')).toBeNull();
	const response = await call(streamed);
	expect(response.status).toBe(413);
	expect(await response.json()).toMatchObject({
		error: { code: 'request_too_large' },
	});
	// It stopped reading just past the limit rather than draining 1.6 MB.
	expect(pulled).toBeLessThan(10);

	expect(budgetNames).toEqual([]);
	expect(providerCalls).toHaveLength(0);
});

test('an exhausted budget answers 429 with Retry-After and never reaches the provider', async () => {
	const env = workerEnv();
	for (let i = 0; i < DEMO_BUDGET.perMinute; i++) {
		const response = await call(demoRequest(validBody), env);
		expect(response.status).toBe(200);
		await response.text();
	}
	const denied = await call(
		demoRequest(validBody, {
			headers: {
				'content-type': 'application/json',
				origin: APPS.ZHONGWEN.url,
			},
		}),
		env,
	);
	expect(denied.status).toBe(429);
	// The clock is pinned 15 s into a minute.
	expect(denied.headers.get('retry-after')).toBe('45');
	expect(denied.headers.get('access-control-expose-headers')).toContain(
		'Retry-After',
	);
	expect((await denied.json()) as unknown).toEqual({
		error: {
			message: 'The demo is at capacity. Try again later.',
			code: 'rate_limit_exceeded',
		},
	});
	expect(providerCalls).toHaveLength(DEMO_BUDGET.perMinute);
});

test('concurrent requests share one budget: exactly the cap reaches the provider', async () => {
	const env = workerEnv();
	const responses = await Promise.all(
		Array.from({ length: 25 }, () => call(demoRequest(validBody), env)),
	);
	const statuses = responses.map((response) => response.status);
	expect(statuses.filter((status) => status === 200)).toHaveLength(
		DEMO_BUDGET.perMinute,
	);
	expect(statuses.filter((status) => status === 429)).toHaveLength(
		25 - DEMO_BUDGET.perMinute,
	);
	expect(providerCalls).toHaveLength(DEMO_BUDGET.perMinute);
	expect(budgetCount()).toBe(DEMO_BUDGET.perMinute);
});

test('fails closed with 503 when the budget is unavailable', async () => {
	const cases = [
		workerEnv({ DEMO_GENERATION_BUDGET: undefined }),
		workerEnv({
			DEMO_GENERATION_BUDGET: budgetNamespace(async () => {
				throw new Error('Durable Object reset');
			}),
		}),
	];
	for (const env of cases) {
		const response = await call(demoRequest(validBody), env);
		expect(response.status).toBe(503);
		expect((await response.json()) as unknown).toEqual({
			error: {
				message: 'Demo generation is unavailable.',
				code: 'demo_unavailable',
			},
		});
	}
	expect(providerCalls).toHaveLength(0);
	expect(hyperdriveReads).toBe(0);
});

test('answers 503 without spending budget when no house key is configured', async () => {
	const response = await call(
		demoRequest(validBody),
		workerEnv({ GEMINI_API_KEY: undefined }),
	);
	expect(response.status).toBe(503);
	expect(await response.json()).toMatchObject({
		error: { code: 'ProviderNotConfigured' },
	});
	expect(budgetCount()).toBe(0);
	expect(providerCalls).toHaveLength(0);
});

test('provider failures answer a generic error and still spend the attempt', async () => {
	const env = workerEnv();
	provider = () =>
		Response.json(
			{
				error: {
					message: `API key ${GEMINI_KEY} invalid at https://generativelanguage.googleapis.com/v1beta`,
				},
			},
			{ status: 400 },
		);
	const rejected = await call(demoRequest(validBody), env);
	expect(rejected.status).toBe(502);
	const text = await rejected.text();
	expect(JSON.parse(text)).toEqual({
		error: {
			message: 'The model provider returned an error.',
			code: 'upstream_error',
		},
	});
	expect(text).not.toContain(GEMINI_KEY);
	expect(text).not.toContain('googleapis');

	provider = () => {
		throw new TypeError(`connect failed to generativelanguage.googleapis.com`);
	};
	const unreachable = await call(demoRequest(validBody), env);
	expect(unreachable.status).toBe(502);
	expect(await unreachable.text()).not.toContain('googleapis');

	expect(budgetCount()).toBe(2);
});

test('a client disconnect aborts the provider call', async () => {
	const client = new AbortController();
	provider = () =>
		new Response(new ReadableStream({ start() {} }), {
			headers: { 'content-type': 'text/event-stream' },
		});
	const response = await call(
		demoRequest(validBody, { signal: client.signal }),
	);
	expect(response.status).toBe(200);

	const upstreamSignal = providerCalls[0]?.init.signal;
	expect(upstreamSignal?.aborted).toBe(false);
	client.abort();
	expect(upstreamSignal?.aborted).toBe(true);
	await response.body?.cancel();
});

test('the ordinary gateway still refuses anonymous requests without reaching the provider', async () => {
	// Its session setup throws on the probe HYPERDRIVE and Hono logs the 500.
	const quiet = spyOn(console, 'error').mockImplementation(() => {});
	for (const headers of <Record<string, string>[]>[
		{ 'content-type': 'application/json' },
		{ 'content-type': 'application/json', authorization: 'Bearer anonymous' },
	]) {
		const response = await call(
			new Request(`${ORIGIN}/v1/chat/completions`, {
				method: 'POST',
				headers,
				body: JSON.stringify(validBody),
			}),
		);
		expect(response.status).toBe(500);
	}
	quiet.mockRestore();
	// It needs its database-backed session check, which the demo route never uses.
	expect(hyperdriveReads).toBeGreaterThan(0);
	expect(providerCalls).toHaveLength(0);
	expect(budgetNames).toEqual([]);
});

// Begin has instructions but no learner turn. This is a real Gemini transport constraint.
test('an instruction-only opening preserves text and supplies Gemini contents without a learner turn', async () => {
	const instructions = 'Open with one Chinese sentence. 你好。';
	const response = await call(
		demoRequest({
			...validBody,
			messages: [{ role: 'system', content: instructions }],
		}),
	);
	expect(response.status).toBe(200);
	await response.body?.cancel();
	expect(JSON.parse(String(providerCalls[0]?.init.body)).messages).toEqual([
		{ role: 'user', content: instructions },
	]);
});

test('an existing conversation preserves its system instructions and learner and assistant roles', async () => {
	const messages = [
		{ role: 'system', content: 'Tutor instructions.' },
		{ role: 'assistant', content: '你好。' },
		{ role: 'user', content: '谢谢。' },
	];
	const response = await call(demoRequest({ ...validBody, messages }));
	expect(response.status).toBe(200);
	await response.body?.cancel();
	expect(JSON.parse(String(providerCalls[0]?.init.body)).messages).toEqual(
		messages,
	);
});

test('browser preflight allows the exact Zhongwen origin without reading the database or budget', async () => {
	const response = await call(
		new Request('https://api.epicenter.so/demo/v1/chat/completions', {
			method: 'OPTIONS',
			headers: {
				origin: APPS.ZHONGWEN.url,
				'access-control-request-method': 'POST',
				'access-control-request-headers': 'content-type',
			},
		}),
	);
	expect(response.status).toBe(204);
	expect(response.headers.get('access-control-allow-origin')).toBe(
		APPS.ZHONGWEN.url,
	);
	expect(response.headers.get('access-control-allow-headers')).toContain(
		'Content-Type',
	);
	expect(providerCalls).toHaveLength(0);
	expect(budgetNames).toEqual([]);
	expect(hyperdriveReads).toBe(0);
});
