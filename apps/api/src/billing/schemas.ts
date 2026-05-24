/**
 * Arktype validators for billing request bodies.
 *
 * One file so the route handlers stay focused on the service call.
 * The shapes here mirror the request types declared in
 * `@epicenter/billing/contracts`.
 */

import { type } from 'arktype';

export const usageQuerySchema = type({
	'range?': "'24h' | '7d' | '30d' | '90d' | 'last_cycle' | undefined",
	'binSize?': "'hour' | 'day' | 'month' | undefined",
	'groupBy?': "'model' | 'provider' | undefined",
	'maxGroups?': 'number | undefined',
});

export const eventsQuerySchema = type({
	'limit?': 'number | undefined',
	'startingAfter?': 'string | undefined',
});

export const checkoutPlanSchema = type({
	planId: 'string',
	'successUrl?': 'string | undefined',
});

export const previewPlanSchema = type({ planId: 'string' });

export const checkoutTopUpSchema = type({
	'successUrl?': 'string | undefined',
});
