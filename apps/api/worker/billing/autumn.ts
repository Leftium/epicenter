/**
 * Autumn SDK adapter: the only file in `billing/` that imports `autumn-js`.
 *
 * Everything that knows about the provider lives here, so the service,
 * policies, and routes stay vendor-agnostic:
 *
 *   createAutumnClient(env)   build the per-request client with the
 *                             fail-closed invariant baked in.
 *   mapAutumnError(error)     translate any thrown provider failure into the
 *                             opaque `BillingError` envelope.
 *   isAutumnError(error)      narrow a throw to a provider failure (vs a bug),
 *                             so route `onError` can rethrow real 500s.
 *   tryAutumn(fn)             run a provider call and return a `Result`,
 *                             mapping a throw to `BillingError`.
 */

import { Autumn, AutumnError } from 'autumn-js';
import { extractErrorMessage } from 'wellcrafted/error';
import { type Result, tryAsync } from 'wellcrafted/result';
import { BillingError } from './errors.js';

/**
 * Build a per-request Autumn client.
 *
 * The SDK defaults `failOpen: true`, meaning a vendor outage causes `check()`
 * to silently allow the request. That is the wrong default for paid features:
 * if we cannot verify entitlement, we must reject. `failOpen: false` makes
 * every billing check fail CLOSED (it throws instead of returning a dummy
 * `allowed: true`), and `balances.finalize` / `billing.attach` were never in
 * the fail-open set regardless. This is the single owner of that invariant.
 */
export function createAutumnClient(env: { AUTUMN_SECRET_KEY: string }): Autumn {
	return new Autumn({ secretKey: env.AUTUMN_SECRET_KEY, failOpen: false });
}

/**
 * Map any thrown provider failure to the opaque `BillingError` envelope.
 *
 * One total path: an `AutumnError` (non-2xx provider response) and a raw
 * network/connection throw both reduce to a single human-readable message. We
 * deliberately do NOT parse the provider body for a machine `code` or forward
 * its HTTP status: a `BillingError` is "billing is temporarily unavailable,"
 * and it always answers with a fixed 503 at the HTTP boundary.
 *
 * Returns the wellcrafted `Err` envelope (what the `defineErrors` factory
 * produces), so it drops straight into a `tryAsync` `catch` or a `c.json`.
 */
export function mapAutumnError(error: unknown) {
	return BillingError.ProviderRequestFailed({
		message: extractErrorMessage(error),
	});
}

/**
 * Narrow a throw to a provider failure. Route `onError` uses this to translate
 * provider failures into the billing envelope while rethrowing everything else
 * (a programming bug) to a real 500 rather than a misleading "provider
 * unreachable" response.
 */
export function isAutumnError(error: unknown): error is AutumnError {
	return error instanceof AutumnError;
}

/**
 * Run a provider call and return a `Result`, mapping any throw (the fail-closed
 * path under `failOpen: false`) to a `BillingError`. The service's domain
 * operations wrap every Autumn round-trip in this.
 */
export function tryAutumn<T>(
	fn: () => Promise<T>,
): Promise<Result<T, BillingError>> {
	return tryAsync({ try: fn, catch: mapAutumnError });
}
