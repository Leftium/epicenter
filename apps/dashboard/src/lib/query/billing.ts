/**
 * TanStack Query options for billing data.
 *
 * Each export is a query options factory consumed by `createQuery()` in Svelte components.
 * Data flows from the Hono API routes via the typed API client.
 */
import type { EventsParams, UsageParams } from '@epicenter/api/billing-contract';
import { api } from '$lib/api';

/**
 * Centralized query key objects for billing queries.
 *
 * Using a key object instead of inline string arrays prevents typo-based
 * invalidation bugs and makes refactoring safe—rename a key and TypeScript
 * catches every stale reference.
 *
 * @example
 * ```typescript
 * queryClient.invalidateQueries({ queryKey: billingKeys.all });
 * queryClient.invalidateQueries({ queryKey: billingKeys.balance });
 * ```
 */
export const billingKeys = {
	all: ['billing'] as const,
	balance: ['billing', 'balance'] as const,
	usage: (params: UsageParams) => ['billing', 'usage', params] as const,
	events: (params: EventsParams) => ['billing', 'events', params] as const,
	plans: ['billing', 'plans'] as const,
	models: ['billing', 'models'] as const,
};
/** Fetch customer balance, subscription, and credit breakdown. */
export function balanceQueryOptions() {
	return {
		queryKey: billingKeys.balance,
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
export function usageQueryOptions(params: UsageParams = {}) {
	return {
		queryKey: billingKeys.usage(params),
		queryFn: () => api.billing.usage(params),
		staleTime: 60_000,
	};
}

/** Fetch paginated event history for the activity feed. */
export function eventsQueryOptions(params: EventsParams = {}) {
	return {
		queryKey: billingKeys.events(params),
		queryFn: () => api.billing.events(params),
		staleTime: 30_000,
	};
}

/** Fetch available plans with customer eligibility. */
export function plansQueryOptions() {
	return {
		queryKey: billingKeys.plans,
		queryFn: () => api.billing.plans(),
		staleTime: 120_000,
	};
}

/** Fetch model credits map and plan metadata. */
export function modelsQueryOptions() {
	return {
		queryKey: billingKeys.models,
		queryFn: () => api.billing.models(),
		staleTime: 300_000,
	};
}
