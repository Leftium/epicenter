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

type AiReserveOutcome = Result<
	Record<never, never>,
	| ReturnType<typeof AiChatError.UnknownModel>['error']
	| ReturnType<typeof AiChatError.InsufficientCredits>['error']
>;

const finalizeCalls: Array<'confirm' | 'release'> = [];
let aiReserveOutcome: AiReserveOutcome = Ok({});

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
	}),
}));

const { chargeOpenAiCreditsWithAutumn } = await import('./policies.js');

beforeEach(() => {
	finalizeCalls.length = 0;
	aiReserveOutcome = Ok({});
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
