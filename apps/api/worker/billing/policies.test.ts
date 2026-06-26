/**
 * Billing policy orchestration tests.
 *
 * Pins the no-overcharge contract for AI: reservations are committed (`confirm`)
 * only on a successful response and rolled back (`release`) otherwise. The
 * service (every Autumn round-trip) is mocked at its module boundary; these
 * tests own only the policy's HTTP orchestration.
 *
 * The reservation object hides the `lockId`: the policy only ever calls
 * `confirm()` / `release()`, so there is no lock action to mispair. The policy
 * pushes the settlement op onto `afterResponse` by calling it, so
 * confirm/release are recorded synchronously during the request.
 *
 * A worker crash between reserve and finalize is intentionally NOT exercised:
 * that path is covered by Autumn's lock TTL auto-release, not by code here.
 */

import { beforeEach, expect, mock, test } from 'bun:test';
import { AiChatError } from '@epicenter/constants/ai-chat-errors';
import type { Env } from '@epicenter/server';
import { Hono } from 'hono';
import { Ok, type Result } from 'wellcrafted/result';
import { BillingError } from './errors.js';

type AiReserveOutcome = Result<
	Record<never, never>,
	| ReturnType<typeof AiChatError.UnknownModel>['error']
	| ReturnType<typeof AiChatError.InsufficientCredits>['error']
>;

const finalizeCalls: Array<'confirm' | 'release'> = [];
let aiReserveOutcome: AiReserveOutcome = Ok({});

type CreditGateOutcome = Result<
	{ allowed: boolean; balance: unknown },
	ReturnType<typeof BillingError.ProviderRequestFailed>['error']
>;
let creditGateOutcome: CreditGateOutcome = Ok({ allowed: true, balance: 100 });
const trackCalls: Array<{ seconds: number; model: string; provider: string }> =
	[];

/** A reservation whose confirm/release record the action and resolve Ok. */
function recordingReservation() {
	return {
		confirm: () => {
			finalizeCalls.push('confirm');
			return Promise.resolve(Ok(undefined));
		},
		release: () => {
			finalizeCalls.push('release');
			return Promise.resolve(Ok(undefined));
		},
	};
}

mock.module('./service.js', () => ({
	createBillingService: () => ({
		reserveAiChat: async (_input: { model: string }) =>
			aiReserveOutcome.error ? aiReserveOutcome : Ok(recordingReservation()),
		checkAiCredits: async () => creditGateOutcome,
		trackAiTranscription: async (input: {
			seconds: number;
			model: string;
			provider: string;
		}) => {
			trackCalls.push(input);
			return Ok(undefined);
		},
	}),
}));

const { chargeOpenAiCreditsWithAutumn, chargeOpenAiTranscriptionCredits } =
	await import('./policies.js');

beforeEach(() => {
	finalizeCalls.length = 0;
	aiReserveOutcome = Ok({});
	creditGateOutcome = Ok({ allowed: true, balance: 100 });
	trackCalls.length = 0;
});

function withContext(app: Hono<Env>) {
	app.use('*', async (c, next) => {
		c.set('afterResponseQueue', []);
		c.set('user', {
			id: 'user_1',
			email: 'user@example.com',
		} as Env['Variables']['user']);
		await next();
	});
	return app;
}

// ----- AI inference policy (the OpenAI-compatible gateway) --------------

/** Mount the inference policy around a stub completions handler returning `downstreamStatus`. */
function makeAiApp(downstreamStatus: 200 | 500) {
	const app = withContext(new Hono<Env>());
	app.use('/v1/chat/completions', chargeOpenAiCreditsWithAutumn);
	app.post('/v1/chat/completions', (c) => c.body(null, downstreamStatus));
	return app;
}

function aiRequest(app: Hono<Env>, body: unknown) {
	return app.request('/v1/chat/completions', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
}

test('a successful completion (200) confirms the reservation', async () => {
	const res = await aiRequest(makeAiApp(200), { model: 'gpt' });

	expect(res.status).toBe(200);
	expect(finalizeCalls).toEqual(['confirm']);
});

test('a pre-stream failure (>= 400) releases the reservation, never charging', async () => {
	const res = await aiRequest(makeAiApp(500), { model: 'gpt' });

	expect(res.status).toBe(500);
	expect(finalizeCalls).toEqual(['release']);
});

test('a guard rejection answers in the OpenAI error shape and reserves nothing', async () => {
	aiReserveOutcome = AiChatError.InsufficientCredits({ balance: 0 });

	const res = await aiRequest(makeAiApp(200), { model: 'gpt' });

	expect(res.status).toBe(402);
	const body = (await res.json()) as {
		error: { code: string; message: string };
	};
	expect(body.error.code).toBe('InsufficientCredits');
	expect(body.error.message).toBeString();
	expect(finalizeCalls).toHaveLength(0);
});

// ----- AI transcription policy (the OpenAI-compatible STT gateway) ------

/**
 * Mount the transcription policy around a stub STT handler. On 200 the handler
 * returns a verbose_json body carrying `duration`, the field the policy reads to
 * settle the per-minute charge after the call.
 */
function makeSttApp(downstream: { status: 200 | 429; duration?: number }) {
	const app = withContext(new Hono<Env>());
	app.use('/v1/audio/transcriptions', chargeOpenAiTranscriptionCredits);
	app.post('/v1/audio/transcriptions', (c) =>
		c.body(
			JSON.stringify(
				downstream.status === 200
					? { text: 'hi', duration: downstream.duration }
					: { error: { message: 'rate limited', code: 'rate_limit_exceeded' } },
			),
			downstream.status,
			{ 'content-type': 'application/json' },
		),
	);
	return app;
}

function sttRequest(app: Hono<Env>) {
	const form = new FormData();
	form.append('file', new File([new Uint8Array([1, 2, 3])], 'audio.webm'));
	form.append('model', 'whisper-large-v3-turbo');
	return app.request('/v1/audio/transcriptions', { method: 'POST', body: form });
}

test('an empty wallet is denied (402) before transcribing and nothing is tracked', async () => {
	creditGateOutcome = Ok({ allowed: false, balance: 0 });

	const res = await sttRequest(makeSttApp({ status: 200, duration: 125 }));

	expect(res.status).toBe(402);
	const body = (await res.json()) as { error: { code: string } };
	expect(body.error.code).toBe('InsufficientCredits');
	expect(trackCalls).toHaveLength(0);
});

test('a successful transcription (200) tracks the returned duration after the call', async () => {
	const res = await sttRequest(makeSttApp({ status: 200, duration: 125 }));

	expect(res.status).toBe(200);
	expect(trackCalls).toEqual([
		{ seconds: 125, model: 'whisper-large-v3-turbo', provider: 'groq' },
	]);
});

test('a non-200 transcription tracks nothing (no charge on failure)', async () => {
	const res = await sttRequest(makeSttApp({ status: 429 }));

	expect(res.status).toBe(429);
	expect(trackCalls).toHaveLength(0);
});

test('a billing-provider outage on the gate fails closed (503) and tracks nothing', async () => {
	creditGateOutcome = BillingError.ProviderRequestFailed();

	const res = await sttRequest(makeSttApp({ status: 200, duration: 60 }));

	expect(res.status).toBe(503);
	expect(trackCalls).toHaveLength(0);
});
