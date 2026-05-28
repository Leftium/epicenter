/**
 * Wire URL prefix for the `/api/billing/*` surface.
 *
 * Hosted-only. Lives in `apps/api/worker/billing/` (not
 * `@epicenter/constants/api-routes`) because billing is a hosted personal
 * cloud concern; self-hosted team deployments never mount this prefix.
 */

export const BILLING_ROUTES = {
	prefixPattern: '/api/billing/*',
} as const;
