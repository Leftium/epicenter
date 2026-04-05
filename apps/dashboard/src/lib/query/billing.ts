/**
 * TanStack Query options for billing data.
 *
 * Each export is a query options factory consumed by `createQuery()` in Svelte components.
 * Data flows from the Hono API routes via the `hc` client.
 */
import { api } from '$lib/api';

/** Fetch customer balance, subscription, and credit breakdown. */
export function balanceQueryOptions() {
	return {
		queryKey: ['billing', 'balance'],
		queryFn: async () => {
			const res = await api.api.billing.balance.$get();
			if (!res.ok) throw new Error('Failed to fetch balance');
			return res.json();
		},
		staleTime: 30_000,
	};
}

/**
 * Fetch aggregated usage data for charts.
 *
 * @example
 * ```typescript
 * const usage = createQuery(usageQueryOptions({ range: '30d', binSize: 'day', groupBy: 'properties.model' }));
 * ```
 */
export function usageQueryOptions(
	params: {
		range?: '24h' | '7d' | '30d' | '90d' | 'last_cycle';
		binSize?: 'hour' | 'day' | 'month';
		groupBy?: 'properties.model' | 'properties.provider';
		maxGroups?: number;
	} = {},
) {
	return {
		queryKey: ['billing', 'usage', params],
		queryFn: async () => {
			const res = await api.api.billing.usage.$post({ json: params });
			if (!res.ok) throw new Error('Failed to fetch usage');
			return res.json();
		},
		staleTime: 60_000,
	};
}

/** Fetch paginated event history for the activity feed. */
export function eventsQueryOptions(
	params: { limit?: number; startingAfter?: string } = {},
) {
	return {
		queryKey: ['billing', 'events', params],
		queryFn: async () => {
			const res = await api.api.billing.events.$post({ json: params });
			if (!res.ok) throw new Error('Failed to fetch events');
			return res.json();
		},
		staleTime: 30_000,
	};
}

/** Fetch available plans with customer eligibility. */
export function plansQueryOptions() {
	return {
		queryKey: ['billing', 'plans'],
		queryFn: async () => {
			const res = await api.api.billing.plans.$get();
			if (!res.ok) throw new Error('Failed to fetch plans');
			return res.json();
		},
		staleTime: 120_000,
	};
}

/** Fetch model credits map and plan metadata. */
export function modelsQueryOptions() {
	return {
		queryKey: ['billing', 'models'],
		queryFn: async () => {
			const res = await api.api.billing.models.$get();
			if (!res.ok) throw new Error('Failed to fetch models');
			return res.json();
		},
		staleTime: 300_000, // model costs change rarely
	};
}
