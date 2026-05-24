/**
 * Single entry point for constructing Autumn SDK clients.
 *
 * `failOpen` defaults to `true` in autumn-js: when the Autumn API is
 * unreachable, `check()` returns `{ allowed: true }` so that customer
 * features don't go dark on a vendor outage. That is the wrong default
 * for paid features in this hub; if we can't verify entitlement, we
 * must reject. This factory forces `failOpen: false` so every billing
 * check in the cloud worker fails CLOSED for AI usage, storage, plan
 * gating, and credit checks. (Routes that read non-authoritative data
 * like usage charts handle their own errors at the route boundary.)
 *
 * Stateless: safe to call per-request. No connection pooling needed.
 */

import { Autumn } from 'autumn-js';

export function createAutumn(env: { AUTUMN_SECRET_KEY: string }) {
	return new Autumn({
		secretKey: env.AUTUMN_SECRET_KEY,
		failOpen: false,
	});
}

export type AutumnClient = ReturnType<typeof createAutumn>;
