/**
 * TanStack Query options for billing data.
 *
 * Each export is a query options factory consumed by `createQuery()` in Svelte components.
 * Data flows from the Hono API routes via the typed API client.
 */
import { api } from '$lib/api';

/** Fetch customer balance, subscription, and credit breakdown. */
export function balanceQueryOptions() {
	return {
		queryKey: ['billing', 'balance'],
		queryFn: () => api.billing.balance(),
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
		range?: string;
		binSize?: string;
		groupBy?: string;
		maxGroups?: number;
	} = {},
) {
	return {
		queryKey: ['billing', 'usage', params],
		queryFn: () => api.billing.usage(params),
		staleTime: 60_000,
	};
}

/** Fetch paginated event history for the activity feed. */
export function eventsQueryOptions(
	params: { limit?: number; startingAfter?: string } = {},
) {
	return {
		queryKey: ['billing', 'events', params],
		queryFn: () => api.billing.events(params),
		staleTime: 30_000,
	};
}

/** Fetch available plans with customer eligibility. */
export function plansQueryOptions() {
	return {
		queryKey: ['billing', 'plans'],
		queryFn: () => api.billing.plans(),
		staleTime: 120_000,
	};
}

/** Fetch model credits map and plan metadata. */
export function modelsQueryOptions() {
	return {
		queryKey: ['billing', 'models'],
		queryFn: () => api.billing.models(),
		staleTime: 300_000,
	};
}
