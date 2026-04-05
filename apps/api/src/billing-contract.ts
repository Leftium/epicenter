/**
 * Billing route contract — the shared type boundary between server and client.
 *
 * This file is the "C" that defines both "A" and "B":
 * - The API routes (A) satisfy these types when returning responses
 * - The dashboard client (B) consumes these types for typed fetch calls
 * - Neither derives from the other; both derive from this contract
 *
 * Zero runtime imports. Zero Cloudflare deps. Safe to import from anywhere.
 *
 * @see docs/articles/shared-contract-over-derived-types.md
 */

// ── Request types ────────────────────────────────────────────────────

export type UsageParams = {
	range?: '24h' | '7d' | '30d' | '90d' | 'last_cycle';
	binSize?: 'hour' | 'day' | 'month';
	groupBy?: 'properties.model' | 'properties.provider';
	maxGroups?: number;
};

export type EventsParams = {
	limit?: number;
	startingAfter?: string;
};

export type AttachParams = {
	planId: string;
	successUrl?: string;
};

// ── Response types ───────────────────────────────────────────────────

export type BalanceSubscription = {
	planId: string;
	addOn?: boolean;
	status?: string;
	cancelAtEnd?: boolean;
};

export type BalanceBreakdownEntry = {
	interval?: string;
	balance: number;
	next_reset_at?: string;
};

export type BalanceFeature = {
	balance: number;
	included_usage: number;
	breakdown?: BalanceBreakdownEntry[];
};

/**
 * Customer balance, subscriptions, and credit breakdown.
 *
 * The `balances` record is keyed by feature ID (e.g., `ai_credits`).
 * Each feature has a `breakdown` array separating monthly, rollover,
 * and top-up credit sources—Autumn tracks deduction order automatically.
 */
export type BalanceResponse = {
	subscriptions?: BalanceSubscription[];
	balances?: Record<string, BalanceFeature>;
};

export type UsagePeriod = {
	values?: { ai_usage?: number };
	grouped_values?: { ai_usage?: Record<string, number> };
};

/**
 * Aggregated usage data for charts.
 *
 * `list` contains one entry per time bin (hour/day/month).
 * `grouped_values` breaks down each bin by model or provider.
 * `total` aggregates across the full range.
 */
export type UsageResponse = {
	list?: UsagePeriod[];
	total?: {
		ai_usage?: { sum?: number; count?: number };
	};
};

export type UsageEvent = {
	timestamp?: string | number;
	created_at?: string;
	value?: number;
	properties?: { model?: string; provider?: string };
};

/** Paginated list of individual usage events. */
export type EventsResponse = {
	list?: UsageEvent[];
};

export type PlanEligibility = {
	id: string;
	customerEligibility?: { attachAction: string };
};

/** Available plans with per-customer eligibility. */
export type PlansResponse = {
	list?: PlanEligibility[];
};

/**
 * Model credit costs plus plan metadata.
 *
 * `credits` maps model name → credit cost per call.
 * `plans` and `annualPlans` are the full PLANS/ANNUAL_PLANS objects
 * from billing-plans.ts, included so the dashboard can derive
 * display data without hardcoding prices.
 */
export type ModelsResponse = {
	credits: Record<string, number>;
	plans: Record<string, unknown>;
	annualPlans: Record<string, unknown>;
};

/** Result of attaching a plan or purchasing a top-up. */
export type AttachResponse = {
	paymentUrl?: string;
};

/** Upgrade cost preview from previewAttach. */
export type PreviewResponse = {
	prorationAmount?: number;
	currency?: string;
};

/** Stripe customer portal URL. */
export type PortalResponse = {
	url?: string;
};

// ── Route map ────────────────────────────────────────────────────────

/**
 * Complete billing route contract.
 *
 * Each entry maps a route to its request/response types.
 * The API routes satisfy this contract; the dashboard consumes it.
 * This type isn't used at runtime—it's documentation-as-code that
 * TypeScript enforces at the module boundary.
 */
export type BillingRouteContract = {
	'GET /balance': { response: BalanceResponse };
	'POST /usage': { body: UsageParams; response: UsageResponse };
	'POST /events': { body: EventsParams; response: EventsResponse };
	'GET /plans': { response: PlansResponse };
	'GET /models': { response: ModelsResponse };
	'POST /preview': { body: { planId: string }; response: PreviewResponse };
	'POST /upgrade': { body: AttachParams; response: AttachResponse };
	'POST /cancel': { body: { planId: string }; response: unknown };
	'POST /uncancel': { body: { planId: string }; response: unknown };
	'POST /top-up': { body: { successUrl?: string }; response: AttachResponse };
	'GET /portal': { response: PortalResponse };
	'POST /controls': { body: unknown; response: unknown };
};
