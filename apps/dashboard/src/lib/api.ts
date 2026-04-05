/**
 * Typed API client for the billing dashboard.
 *
 * Uses direct fetch with auth.fetch for Bearer tokens.
 * Same-origin deployment—no CORS config needed.
 *
 * NOTE: We don't use Hono's hc<AppType> because AppType carries
 * Cloudflare Worker types that svelte-check can't resolve.
 * These thin wrappers give us the same DX with explicit types.
 */
import { auth } from './auth';

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

// ── Autumn response shapes (from spec research findings) ─────────────

/** Balance response from GET /api/billing/balance */
export type BalanceResponse = {
	subscriptions?: Array<{
		planId: string;
		addOn?: boolean;
		status?: string;
		cancelAtEnd?: boolean;
	}>;
	balances?: Record<
		string,
		{
			balance: number;
			included_usage: number;
			breakdown?: Array<{
				interval?: string;
				balance: number;
				next_reset_at?: string;
			}>;
		}
	>;
};

/** Usage aggregate response from POST /api/billing/usage */
export type UsageResponse = {
	list?: Array<{
		values?: { ai_usage?: number };
		grouped_values?: { ai_usage?: Record<string, number> };
	}>;
	total?: {
		ai_usage?: { sum?: number; count?: number };
	};
};

/** Events list response from POST /api/billing/events */
export type EventsResponse = {
	list?: Array<{
		timestamp?: string | number;
		created_at?: string;
		value?: number;
		properties?: { model?: string; provider?: string };
	}>;
};

/** Plans list response from GET /api/billing/plans */
export type PlansResponse = {
	list?: Array<{
		id: string;
		customerEligibility?: { attachAction: string };
	}>;
};

/** Models response from GET /api/billing/models */
export type ModelsResponse = {
	credits: Record<string, number>;
	plans: Record<string, unknown>;
	annualPlans: Record<string, unknown>;
};

/** Upgrade/attach response */
export type AttachResponse = {
	paymentUrl?: string;
};

/** Preview response */
export type PreviewResponse = {
	prorationAmount?: number;
	currency?: string;
};

/** Portal response */
export type PortalResponse = {
	url?: string;
};

// ── API methods ──────────────────────────────────────────────────────

export const api = {
	billing: {
		balance: () => get<BalanceResponse>('/api/billing/balance'),
		usage: (params: {
			range?: string;
			binSize?: string;
			groupBy?: string;
			maxGroups?: number;
		}) => post<typeof params, UsageResponse>('/api/billing/usage', params),
		events: (params: { limit?: number; startingAfter?: string }) =>
			post<typeof params, EventsResponse>('/api/billing/events', params),
		plans: () => get<PlansResponse>('/api/billing/plans'),
		models: () => get<ModelsResponse>('/api/billing/models'),
		preview: (planId: string) =>
			post<{ planId: string }, PreviewResponse>('/api/billing/preview', {
				planId,
			}),
		upgrade: (planId: string, successUrl?: string) =>
			post<{ planId: string; successUrl?: string }, AttachResponse>(
				'/api/billing/upgrade',
				{ planId, successUrl },
			),
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
