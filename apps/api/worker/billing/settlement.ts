/**
 * Post-response billing settlement.
 *
 * A reservation is committed (`confirm`), rolled back (`release`), or a delete
 * is refunded (`credit`) AFTER the response has already been sent, on the
 * server app's `afterResponse` queue. That queue is drained with
 * `Promise.allSettled`, which swallows rejections, so a bare promise pushed
 * onto it would make a finalize/credit failure invisible.
 *
 * `scheduleBillingSettlement` is the floor invariant: no post-response billing
 * failure is silently dropped. It awaits the operation's `Result` and logs the
 * typed error at the caller-chosen level.
 *
 * Severity guide (lock TTL self-heal asymmetry):
 *   - `confirm` failure  -> lock auto-releases at TTL: an undercharge that
 *                           self-heals toward the user. Log at `error` (it is a
 *                           revenue leak worth seeing) but it recovers.
 *   - `release` failure  -> lock auto-releases at TTL anyway. Log at `warn`.
 *   - `credit` failure   -> a delete refund has no lock to expire, so quota
 *                           stays consumed permanently. Log at `error`; this is
 *                           the one a future durable-retry follow-up targets.
 */

import type { Env } from '@epicenter/server';
import type { Context } from 'hono';
import { createLogger, type Logger } from 'wellcrafted/logger';
import type { Result } from 'wellcrafted/result';
import type { BillingError } from './errors.js';

const defaultLog = createLogger('billing');

/**
 * Schedule a billing settlement on the after-response queue, logging the typed
 * error if it fails. `log` is a DI seam: production uses the default console
 * logger; tests pass a `memorySink`-backed logger to assert the event.
 */
export function scheduleBillingSettlement(
	c: Context<Env>,
	level: 'warn' | 'error',
	op: () => Promise<Result<void, BillingError>>,
	log: Logger = defaultLog,
): void {
	c.var.afterResponse.push(
		op().then(({ error }) => {
			if (error) log[level](error);
		}),
	);
}
