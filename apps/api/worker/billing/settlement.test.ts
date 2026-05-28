/**
 * Post-response settlement tests.
 *
 * Pins the floor invariant: a failed finalize/credit on the after-response
 * queue is never silently dropped. `scheduleBillingSettlement` awaits the op's
 * `Result` and logs the typed error at the caller's level. The logger is the DI
 * seam: a `memorySink` captures events so we assert on the event array, never
 * on `console`.
 */

import type { Env } from '@epicenter/server';
import { expect, test } from 'bun:test';
import type { Context } from 'hono';
import { createLogger, memorySink } from 'wellcrafted/logger';
import { Ok, type Result } from 'wellcrafted/result';
import { BillingError } from './errors.js';
import { scheduleBillingSettlement } from './settlement.js';

/** Minimal context exposing only the after-response queue the helper touches. */
function fakeContext() {
	const afterResponse: Promise<unknown>[] = [];
	const c = { var: { afterResponse } } as unknown as Context<Env>;
	return { c, afterResponse };
}

const fail = (): Promise<Result<void, BillingError>> =>
	Promise.resolve(
		BillingError.ProviderRequestFailed({ message: 'finalize failed' }),
	);
const succeed = (): Promise<Result<void, BillingError>> =>
	Promise.resolve(Ok(undefined));

test('a failed settlement logs the typed error at the chosen level', async () => {
	const { sink, events } = memorySink();
	const log = createLogger('billing', sink);
	const { c, afterResponse } = fakeContext();

	scheduleBillingSettlement(c, 'error', fail, log);
	await Promise.all(afterResponse);

	expect(events).toHaveLength(1);
	expect(events[0]).toMatchObject({
		level: 'error',
		message: 'finalize failed',
	});
});

test('a release failure logs at warn, not error', async () => {
	const { sink, events } = memorySink();
	const log = createLogger('billing', sink);
	const { c, afterResponse } = fakeContext();

	scheduleBillingSettlement(c, 'warn', fail, log);
	await Promise.all(afterResponse);

	expect(events).toHaveLength(1);
	expect(events[0]?.level).toBe('warn');
});

test('a successful settlement logs nothing', async () => {
	const { sink, events } = memorySink();
	const log = createLogger('billing', sink);
	const { c, afterResponse } = fakeContext();

	scheduleBillingSettlement(c, 'error', succeed, log);
	await Promise.all(afterResponse);

	expect(events).toHaveLength(0);
});

test('the op is invoked exactly once and its promise lands on the queue', async () => {
	const { c, afterResponse } = fakeContext();
	let calls = 0;
	scheduleBillingSettlement(c, 'error', () => {
		calls += 1;
		return succeed();
	});

	expect(calls).toBe(1);
	expect(afterResponse).toHaveLength(1);
	await Promise.all(afterResponse);
});
