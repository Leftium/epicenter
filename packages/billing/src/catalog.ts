/**
 * Canonical Epicenter billing catalog.
 *
 * One source of truth for every feature, plan, and pricing knob that
 * ships to production. The atmn product builder in
 * `apps/api/autumn.config.ts` reads this catalog and emits Autumn
 * `feature()` / `plan()` / `item()` calls; the billing service in
 * `apps/api/src/billing/service.ts` reads the same catalog to resolve
 * plan tier semantics (rollover policy, top-up plan id, free-tier
 * model-cost ceiling); the dashboard reads it through the
 * server-rendered DTOs from `contracts.ts`. Nothing else in the repo
 * holds plan or feature configuration.
 *
 * IDs in `FEATURE_IDS` and `PLAN_IDS` are durable: they appear in
 * Autumn customer subscriptions, Stripe webhooks, and historical events.
 * Renaming requires a coordinated migration. Adding new ids is safe.
 *
 * Pricing knobs (`included`, `overage.amount`, `storage.includedBytes`,
 * etc.) can change freely; they affect the next atmn push.
 */
export const FEATURE_IDS = {
	/** Per-request usage units (one entry per AI chat call). */
	aiUsage: 'ai_usage',
	/** Credit wallet that wraps `ai_usage` 1:1; what users see and buy. */
	aiCredits: 'ai_credits',
	/** Accumulator (non-consumable) feature tracking total stored bytes. */
	storageBytes: 'storage_bytes',
} as const;

export type FeatureId = (typeof FEATURE_IDS)[keyof typeof FEATURE_IDS];

export const PLAN_IDS = {
	free: 'free',
	pro: 'pro',
	ultra: 'ultra',
	max: 'max',
	creditTopUp: 'credit_top_up',
	proAnnual: 'pro_annual',
	ultraAnnual: 'ultra_annual',
	maxAnnual: 'max_annual',
} as const;

export type PlanId = (typeof PLAN_IDS)[keyof typeof PLAN_IDS];

/** Billing cycle for a subscription plan. `oneOff` for top-ups. */
export type BillingCycle = 'monthly' | 'annual' | 'oneOff';

/** Per-cycle credit grant + overage pricing. Free plan: no overage. */
type CreditPolicy =
	| {
			/** Credits granted at the start of each cycle. */
			grantedPerCycle: number;
			/** When credits reset. `null` for one-off lifetime grants. */
			reset: 'month' | null;
			/** Overage price. Null on plans where overage is not sold. */
			overage: null;
	  }
	| {
			grantedPerCycle: number;
			reset: 'month' | null;
			overage: {
				/** USD price per `billingUnits` overage credits. */
				priceUsd: number;
				billingUnits: number;
				method: 'usage_based' | 'prepaid';
			};
	  };

/** Per-cycle storage grant + per-GB overage pricing. */
type StoragePolicy = {
	includedBytes: number;
	overagePerGbUsd: number;
};

/** Plan attached via Stripe checkout. */
export type SubscriptionPlan = {
	id: PlanId;
	kind: 'subscription';
	displayName: string;
	/** Hardcoded UI grouping; Autumn `group` for mutual exclusion. */
	group: 'main';
	cycle: 'monthly' | 'annual';
	/** True if this plan rolls over unused credits and the cloud should
	 *  carry over balances on upgrade. */
	rollover: boolean;
	/** Auto-enable on customer creation (Autumn-side default for free). */
	autoEnable: boolean;
	/** Base price, billed on `cycle`. Free plan: null. */
	basePrice: { amountUsd: number; interval: 'month' | 'year' } | null;
	/** Free trial offered at attach time. */
	freeTrial: { days: number; cardRequired: boolean } | null;
	/** For annual plans: the id of the equivalent monthly subscription.
	 *  Used to render "annualized monthly" pricing on the upgrade UI. */
	monthlyEquivalentId: PlanId | null;
	credits: CreditPolicy;
	storage: StoragePolicy;
};

/** One-off top-up plan. Attaches a prepaid bag of credits with no
 *  recurring price and no reset. */
export type OneOffTopUpPlan = {
	id: PlanId;
	kind: 'oneOffTopUp';
	displayName: string;
	/** Number of credits granted per purchase. */
	creditsPerPurchase: number;
	/** USD price per purchase. */
	priceUsd: number;
};

export type Plan = SubscriptionPlan | OneOffTopUpPlan;

/** Cap on the per-call credit cost that the free tier may consume.
 *  Resolved against {@link MODEL_CREDITS} at request time. */
export const FREE_TIER_MAX_CREDITS_PER_CALL = 2;

export const PLANS = {
	[PLAN_IDS.free]: {
		id: PLAN_IDS.free,
		kind: 'subscription',
		displayName: 'Free',
		group: 'main',
		cycle: 'monthly',
		rollover: false,
		autoEnable: true,
		basePrice: null,
		freeTrial: null,
		monthlyEquivalentId: null,
		credits: { grantedPerCycle: 50, reset: 'month', overage: null },
		storage: { includedBytes: 0, overagePerGbUsd: 0 },
	},
	[PLAN_IDS.pro]: {
		id: PLAN_IDS.pro,
		kind: 'subscription',
		displayName: 'Pro',
		group: 'main',
		cycle: 'monthly',
		rollover: false,
		autoEnable: false,
		basePrice: { amountUsd: 20, interval: 'month' },
		freeTrial: null,
		monthlyEquivalentId: null,
		credits: {
			grantedPerCycle: 2500,
			reset: 'month',
			overage: { priceUsd: 1, billingUnits: 100, method: 'usage_based' },
		},
		storage: { includedBytes: 5_000_000_000, overagePerGbUsd: 1 },
	},
	[PLAN_IDS.ultra]: {
		id: PLAN_IDS.ultra,
		kind: 'subscription',
		displayName: 'Ultra',
		group: 'main',
		cycle: 'monthly',
		rollover: true,
		autoEnable: false,
		basePrice: { amountUsd: 60, interval: 'month' },
		freeTrial: { days: 14, cardRequired: false },
		monthlyEquivalentId: null,
		credits: {
			grantedPerCycle: 10_000,
			reset: 'month',
			overage: { priceUsd: 0.75, billingUnits: 100, method: 'usage_based' },
		},
		storage: { includedBytes: 10_000_000_000, overagePerGbUsd: 0.75 },
	},
	[PLAN_IDS.max]: {
		id: PLAN_IDS.max,
		kind: 'subscription',
		displayName: 'Max',
		group: 'main',
		cycle: 'monthly',
		rollover: true,
		autoEnable: false,
		basePrice: { amountUsd: 200, interval: 'month' },
		freeTrial: null,
		monthlyEquivalentId: null,
		credits: {
			grantedPerCycle: 50_000,
			reset: 'month',
			overage: { priceUsd: 0.5, billingUnits: 100, method: 'usage_based' },
		},
		storage: { includedBytes: 50_000_000_000, overagePerGbUsd: 0.5 },
	},
	[PLAN_IDS.proAnnual]: {
		id: PLAN_IDS.proAnnual,
		kind: 'subscription',
		displayName: 'Pro (Annual)',
		group: 'main',
		cycle: 'annual',
		rollover: false,
		autoEnable: false,
		basePrice: { amountUsd: 200, interval: 'year' },
		freeTrial: null,
		monthlyEquivalentId: PLAN_IDS.pro,
		credits: {
			grantedPerCycle: 2500,
			reset: 'month',
			overage: { priceUsd: 1, billingUnits: 100, method: 'usage_based' },
		},
		storage: { includedBytes: 5_000_000_000, overagePerGbUsd: 1 },
	},
	[PLAN_IDS.ultraAnnual]: {
		id: PLAN_IDS.ultraAnnual,
		kind: 'subscription',
		displayName: 'Ultra (Annual)',
		group: 'main',
		cycle: 'annual',
		rollover: true,
		autoEnable: false,
		basePrice: { amountUsd: 600, interval: 'year' },
		freeTrial: null,
		monthlyEquivalentId: PLAN_IDS.ultra,
		credits: {
			grantedPerCycle: 10_000,
			reset: 'month',
			overage: { priceUsd: 0.75, billingUnits: 100, method: 'usage_based' },
		},
		storage: { includedBytes: 10_000_000_000, overagePerGbUsd: 0.75 },
	},
	[PLAN_IDS.maxAnnual]: {
		id: PLAN_IDS.maxAnnual,
		kind: 'subscription',
		displayName: 'Max (Annual)',
		group: 'main',
		cycle: 'annual',
		rollover: true,
		autoEnable: false,
		basePrice: { amountUsd: 2000, interval: 'year' },
		freeTrial: null,
		monthlyEquivalentId: PLAN_IDS.max,
		credits: {
			grantedPerCycle: 50_000,
			reset: 'month',
			overage: { priceUsd: 0.5, billingUnits: 100, method: 'usage_based' },
		},
		storage: { includedBytes: 50_000_000_000, overagePerGbUsd: 0.5 },
	},
	[PLAN_IDS.creditTopUp]: {
		id: PLAN_IDS.creditTopUp,
		kind: 'oneOffTopUp',
		displayName: 'Credit Top-Up',
		creditsPerPurchase: 500,
		priceUsd: 5,
	},
} as const satisfies Record<PlanId, Plan>;

/** Ordered list of subscription plans shown on the Upgrade UI.
 *  Free is intentionally excluded; it is the no-op fallback, not a
 *  card the user picks. */
export const VISIBLE_SUBSCRIPTION_PLAN_IDS = {
	monthly: [PLAN_IDS.pro, PLAN_IDS.ultra, PLAN_IDS.max],
	annual: [PLAN_IDS.proAnnual, PLAN_IDS.ultraAnnual, PLAN_IDS.maxAnnual],
} as const;

/** Plans recommended in the upgrade UI (one per cycle). */
export const RECOMMENDED_PLAN_IDS: ReadonlySet<PlanId> = new Set([
	PLAN_IDS.ultra,
	PLAN_IDS.ultraAnnual,
]);

export function isSubscriptionPlan(plan: Plan): plan is SubscriptionPlan {
	return plan.kind === 'subscription';
}

export function isOneOffTopUpPlan(plan: Plan): plan is OneOffTopUpPlan {
	return plan.kind === 'oneOffTopUp';
}

/** Resolve a Plan by id with a type-narrow. Returns undefined for
 *  unknown ids (e.g. legacy plans that have been retired). */
export function getPlan(id: string): Plan | undefined {
	return (PLANS as Record<string, Plan>)[id];
}

export const TOP_UP_PLAN_ID: PlanId = PLAN_IDS.creditTopUp;
