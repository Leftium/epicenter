/**
 * Typed API client for the billing dashboard.
 *
 * Uses direct fetch with auth.fetch for Bearer tokens.
 * Same-origin deployment—no CORS config needed.
 *
 * Response types come from the shared billing contract
 * (`@epicenter/api/billing-contract`), which the API routes also
 * satisfy. Neither side derives from the other—both derive from
 * the contract.
 *
 * @see docs/articles/shared-contract-over-derived-types.md
 */
import type {
	AttachParams,
	AttachResponse,
	BalanceResponse,
	EventsParams,
	EventsResponse,
	ModelsResponse,
	PlansResponse,
	PortalResponse,
	PreviewResponse,
	UsageParams,
	UsageResponse,
} from '@epicenter/api/billing-contract';
import { auth } from './auth';

// Re-export contract types for components that need them
export type {
	AttachResponse,
	BalanceResponse,
	EventsResponse,
	ModelsResponse,
	PlansResponse,
	PortalResponse,
	PreviewResponse,
	UsageResponse,
} from '@epicenter/api/billing-contract';

/** Fetch JSON from an API endpoint with auth. */
async function get<TResponse>(path: string): Promise<TResponse> {
	const res = await auth.fetch(path, { credentials: 'include' });
	if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
	return res.json() as Promise<TResponse>;
}

/** POST JSON to an API endpoint with auth. */
async function post<TBody, TResponse>(
	path: string,
	body: TBody,
): Promise<TResponse> {
	const res = await auth.fetch(path, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
		credentials: 'include',
	});
	if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
	return res.json() as Promise<TResponse>;
}

export const api = {
	billing: {
		balance: () => get<BalanceResponse>('/api/billing/balance'),
		usage: (params: UsageParams) =>
			post<UsageParams, UsageResponse>('/api/billing/usage', params),
		events: (params: EventsParams = {}) =>
			post<EventsParams, EventsResponse>('/api/billing/events', params),
		plans: () => get<PlansResponse>('/api/billing/plans'),
		models: () => get<ModelsResponse>('/api/billing/models'),
		preview: (planId: string) =>
			post<{ planId: string }, PreviewResponse>('/api/billing/preview', {
				planId,
			}),
		upgrade: (planId: string, successUrl?: string) =>
			post<AttachParams, AttachResponse>('/api/billing/upgrade', {
				planId,
				successUrl,
			}),
		cancel: (planId: string) =>
			post<{ planId: string }, unknown>('/api/billing/cancel', { planId }),
		uncancel: (planId: string) =>
			post<{ planId: string }, unknown>('/api/billing/uncancel', { planId }),
		topUp: (successUrl?: string) =>
			post<{ successUrl?: string }, AttachResponse>('/api/billing/top-up', {
				successUrl,
			}),
		portal: () => get<PortalResponse>('/api/billing/portal'),
		controls: (data: unknown) =>
			post<unknown, unknown>('/api/billing/controls', data),
	},
};
