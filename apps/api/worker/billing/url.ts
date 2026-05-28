/**
 * Wire URL paths for the `/api/billing/*` surface.
 *
 * Hosted-only. Lives in `apps/api/worker/billing/` (not
 * `@epicenter/constants/api-routes`) because billing is a hosted personal
 * cloud concern; self-hosted team deployments never mount this prefix.
 *
 * Mirrors the shape of the other entries in `@epicenter/constants/api-routes`
 * so the Worker route mount and dashboard fetch client read identically.
 */

const stripTrailing = (s: string) => s.replace(/\/+$/, '');

export const BILLING_ROUTES = {
	prefixPattern: '/api/billing/*',
	url: (baseURL: string, sub: string) =>
		`${stripTrailing(baseURL)}/api/billing/${sub.replace(/^\/+/, '')}`,
} as const;
