/**
 * TanStack Query definitions for billing data.
 *
 * Uses `defineQuery` from wellcrafted/query so every query accepts
 * a Result-returning queryFn. Components use `.options` for reactive
 * queries, and `.fetch()` / `.execute()` for imperative calls.
 */
import type {
	EventsParams,
	UsageParams,
} from '@epicenter/api/billing-contract';
import { api } from '$lib/api';
import { defineMutation, defineQuery } from '$lib/query/client';

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
export const balance = defineQuery({
	queryKey: billingKeys.balance,
	queryFn: () => api.billing.balance(),
});

/**
 * Fetch aggregated usage data for charts.
 *
 * @example
 * ```typescript
 * const usage = createQuery(() => usageQueryOptions({ range: '30d', binSize: 'day' }));
 * ```
 */
export function usageQueryOptions(params: UsageParams = {}) {
	return defineQuery({
		queryKey: billingKeys.usage(params),
		queryFn: () => api.billing.usage(params),
	}).options;
}

/** Fetch paginated event history for the activity feed. */
export function eventsQueryOptions(params: EventsParams = {}) {
	return defineQuery({
		queryKey: billingKeys.events(params),
		queryFn: () => api.billing.events(params),
	}).options;
}

/** Fetch available plans with customer eligibility. */
export const plans = defineQuery({
	queryKey: billingKeys.plans,
	queryFn: () => api.billing.plans(),
});

/** Fetch model credits map and plan metadata. */
export const models = defineQuery({
	queryKey: billingKeys.models,
	queryFn: () => api.billing.models(),
});

/** Buy 500 credits via Stripe checkout. */
export const topUp = defineMutation({
	mutationKey: [...billingKeys.all, 'top-up'] as const,
	mutationFn: (successUrl?: string) => api.billing.topUp(successUrl),
});

/** Preview proration cost before changing plans. */
export const previewUpgrade = defineMutation({
	mutationKey: [...billingKeys.all, 'preview'] as const,
	mutationFn: (planId: string) => api.billing.preview(planId),
});

/** Upgrade or switch billing plan via Stripe. */
export const upgradePlan = defineMutation({
	mutationKey: [...billingKeys.all, 'upgrade'] as const,
	mutationFn: ({
		planId,
		successUrl,
	}: {
		planId: string;
		successUrl?: string;
	}) => api.billing.upgrade(planId, successUrl),
});
