/**
 * Billing service.
 *
 * Owns every billing domain operation in the cloud worker. Routes and
 * policies call into this service, which returns Epicenter DTOs from
 * `./contracts.ts` (dashboard reads) or reservation objects (the AI and
 * storage guards). It never imports `autumn-js`: the Autumn SDK lives
 * behind `./autumn.ts`, which builds the client, wraps each round-trip in
 * `tryAutumn`, and translates provider throws into `BillingError`.
 *
 * Lifecycle: one service per request. Construct via
 * `createBillingService(env, { userId, userEmail })`. The service does
 * NOT cache the customer across calls; each public method makes the
 * Autumn calls it needs and returns its result.
 *
 * Two error shapes, on purpose. Dashboard reads (`getOverview`, `listPlans`,
 * `listUsage`, ...) call Autumn directly and let a provider failure THROW; the
 * single `onError` boundary in `routes.ts` turns it into the opaque 503. The
 * usage guards (`reserveAiChat`, `reserveAssetStorage`) instead wrap their
 * Autumn calls in `tryAutumn` and RETURN `Result`, because a guard takes a
 * reservation lock the policy must settle (confirm or release) around the
 * response via the after-response queue. Returning the reservation lets the
 * policy settle it; throwing would skip the settle and leave the hold to expire
 * only at its TTL. So "reads throw, guards return" is the reservation lifecycle
 * showing through, not an inconsistency.
 */

import type { UserId } from '@epicenter/auth';
import { AiChatError } from '@epicenter/constants/ai-chat-errors';
import { AssetError } from '@epicenter/constants/asset-errors';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { MODEL_CREDITS } from './ai-model-pricing.js';
import {
	type CheckoutPlanId,
	FEATURE_IDS,
	FREE_TIER_MAX_CREDITS_PER_CALL,
	getPlan,
	PLAN_IDS,
	PLANS,
	type PlanId,
	VISIBLE_SUBSCRIPTION_PLAN_IDS,
} from './catalog.js';
import type {
	BillingEvent,
	BillingEventsPage,
	BillingOverview,
	BillingPlanCard,
	BillingPlansView,
	CheckoutResult,
	EventsQuery,
	PlanChangePreview,
	PortalSession,
	UsageQuery,
	UsageSeries,
} from './contracts.js';
import { createAutumnClient, tryAutumn } from './autumn.js';
import type { BillingError } from './errors.js';

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

type Identity = {
	userId: UserId;
	/** AuthUser.email is always a string (Better Auth guarantee); no
	 *  null coercion needed at the boundary. */
	userEmail: string;
};

// ---------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------

/** How long a reservation lock holds the balance before Autumn auto-releases
 *  it. If the worker dies before finalizing, the hold expires here, so a failed
 *  request never permanently consumes credits or quota. */
const LOCK_TTL_MS = 15 * 60_000;

/**
 * A held reservation taken by `reserveAiChat` or `reserveAssetStorage`. The
 * `lockId` is captured in the closure and never escapes the service: the policy
 * commits with `confirm()` on success or rolls back with `release()` on
 * failure, so the lock action can't be mispaired.
 */
type Reservation = {
	confirm(): Promise<Result<void, BillingError>>;
	release(): Promise<Result<void, BillingError>>;
};

export function createBillingService(
	env: { AUTUMN_SECRET_KEY: string },
	identity: Identity,
) {
	const autumn = createAutumnClient(env);

	// ----- AI guard -----------------------------------------------------

	/**
	 * Reserve AI credits for one chat call. On success returns a reservation the
	 * policy commits or releases around the downstream handler; on failure
	 * returns a typed reason (unknown model, free-tier ceiling, insufficient
	 * balance, or a fail-closed provider outage).
	 */
	async function reserveAiChat(input: {
		model: string;
		provider: string | undefined;
	}): Promise<Result<Reservation, AiChatError | BillingError>> {
		const credits = MODEL_CREDITS[input.model as keyof typeof MODEL_CREDITS];
		if (credits === undefined) {
			return AiChatError.UnknownModel({ model: input.model });
		}

		// Resolve the active plan from a single customer fetch. A billing-provider
		// outage fails closed: entitlement cannot be verified, so deny.
		const { data: customer, error: customerError } = await tryAutumn(() =>
			loadCustomer(),
		);
		if (customerError) return Err(customerError);

		const mainSub = customer.subscriptions.find((s) => !s.addOn) ?? null;
		const planId = mainSub?.planId ?? PLAN_IDS.free;

		// Free tier rejects models above the per-call ceiling.
		if (planId === PLAN_IDS.free && credits > FREE_TIER_MAX_CREDITS_PER_CALL) {
			return AiChatError.ModelRequiresPaidPlan({ model: input.model, credits });
		}

		// Reserve the credits with a lock instead of an immediate deduct: the lock
		// holds the balance (concurrent calls can't double-spend) and the returned
		// reservation commits on success or releases on a pre-stream failure. If
		// the worker dies before finalizing, Autumn auto-releases at `expiresAt`,
		// so a failed call never permanently consumes credits.
		const lockId = crypto.randomUUID();
		const { data: check, error: checkError } = await tryAutumn(() =>
			autumn.check({
				customerId: identity.userId,
				featureId: FEATURE_IDS.aiUsage,
				requiredBalance: credits,
				lock: {
					lockId,
					enabled: true,
					expiresAt: Date.now() + LOCK_TTL_MS,
				},
				properties: { model: input.model, provider: input.provider },
			}),
		);
		if (checkError) return Err(checkError);
		if (!check.allowed) {
			return AiChatError.InsufficientCredits({ balance: check.balance });
		}

		return Ok({
			confirm: () => finalizeLock(lockId, 'confirm'),
			release: () => finalizeLock(lockId, 'release'),
		});
	}

	// ----- Storage guard ------------------------------------------------

	/**
	 * Reserve storage bytes for one upload. Same reservation lifecycle as
	 * {@link reserveAiChat}: the policy confirms on a 201 or releases otherwise.
	 */
	async function reserveAssetStorage(input: {
		sizeBytes: number;
	}): Promise<Result<Reservation, AssetError | BillingError>> {
		// Seed the customer so the storage balance materializes from the
		// auto-enable free plan before we reserve against it. A provider outage
		// fails closed.
		const { error: seedError } = await tryAutumn(() =>
			autumn.customers.getOrCreate({
				customerId: identity.userId,
				email: identity.userEmail,
			}),
		);
		if (seedError) return Err(seedError);

		// Reserve the bytes with a lock instead of deduct-then-refund: the lock
		// holds the balance atomically (two concurrent uploads can't both pass)
		// and the returned reservation commits on a 201 or releases otherwise. If
		// the worker dies before finalizing, Autumn auto-releases at `expiresAt`,
		// so a failed upload never permanently consumes quota.
		const lockId = crypto.randomUUID();
		const { data: check, error: checkError } = await tryAutumn(() =>
			autumn.check({
				customerId: identity.userId,
				featureId: FEATURE_IDS.storageBytes,
				requiredBalance: input.sizeBytes,
				lock: {
					lockId,
					enabled: true,
					expiresAt: Date.now() + LOCK_TTL_MS,
				},
			}),
		);
		if (checkError) return Err(checkError);
		if (!check.allowed) {
			return AssetError.StorageLimitExceeded({ requestedBytes: input.sizeBytes });
		}
		return Ok({
			confirm: () => finalizeLock(lockId, 'confirm'),
			release: () => finalizeLock(lockId, 'release'),
		});
	}

	/**
	 * Credit storage bytes back after a delete. A delete has no prior
	 * reservation to finalize, so this is a direct negative-usage track of the
	 * freed bytes. Unlike a lock, this does not self-heal on failure, so the
	 * policy logs a failed credit at `error`.
	 */
	function creditAssetStorage(
		sizeBytes: number,
	): Promise<Result<void, BillingError>> {
		return tryAutumn(async () => {
			await autumn.track({
				customerId: identity.userId,
				featureId: FEATURE_IDS.storageBytes,
				value: -sizeBytes,
			});
		});
	}


	// ----- Dashboard data plane -----------------------------------------

	async function getOverview(): Promise<BillingOverview> {
		const customer = await loadCustomer();
		const mainSub = customer.subscriptions.find((s) => !s.addOn) ?? null;
		const planId = mainSub?.planId ?? PLAN_IDS.free;
		const catalogPlan = getPlan(planId);
		const planDisplayName =
			mainSub?.plan?.name ?? (catalogPlan ? catalogPlan.displayName : planId);

		const creditsBalance = customer.balances?.[FEATURE_IDS.aiCredits];
		const monthlyEntry = creditsBalance?.breakdown?.find(
			(e) => e.reset?.interval === 'month',
		);
		const rolloverEntry = creditsBalance?.rollovers?.[0];
		const storageBalance = customer.balances?.[FEATURE_IDS.storageBytes];
		const storageIncluded =
			catalogPlan && catalogPlan.kind === 'subscription'
				? catalogPlan.storage.includedBytes
				: 0;

		const trial =
			mainSub?.trialEndsAt != null
				? {
						endsAtMs: mainSub.trialEndsAt,
						daysLeft: Math.max(
							0,
							Math.ceil((mainSub.trialEndsAt - Date.now()) / 86_400_000),
						),
					}
				: null;

		return {
			planDisplayName,
			trial,
			credits: {
				remaining: creditsBalance?.remaining ?? 0,
				granted: creditsBalance?.granted ?? 0,
				monthlyRemaining: monthlyEntry?.remaining ?? 0,
				rolloverRemaining: rolloverEntry?.balance ?? 0,
				nextResetAtMs: creditsBalance?.nextResetAt ?? null,
			},
			storage: {
				usedBytes: storageBalance?.usage ?? 0,
				includedBytes: storageBalance?.granted ?? storageIncluded,
			},
		};
	}

	async function listPlans(): Promise<BillingPlansView> {
		// Seed the customer (so plans.list reflects the auto-enabled free plan
		// and any active subscription), then read per-plan eligibility. Autumn
		// owns the customer's relationship to each plan; the card no longer
		// compares plan ids client-side.
		const [, autumnPlans] = await Promise.all([
			autumn.customers.getOrCreate({
				customerId: identity.userId,
				email: identity.userEmail,
			}),
			autumn.plans.list({ customerId: identity.userId }),
		]);

		const eligibilityByPlanId = new Map(
			(autumnPlans.list ?? []).map((p) => [p.id, p.customerEligibility] as const),
		);

		function renderCard(planId: PlanId): BillingPlanCard {
			const plan = PLANS[planId];
			// Runtime guard, not a type-level proof: VISIBLE_SUBSCRIPTION_PLAN_IDS
			// is hand-maintained, so nothing in the type system stops the top-up
			// id from being added there. This throw catches that mistake.
			if (plan.kind !== 'subscription') {
				throw new Error(`Plan ${planId} is not a subscription plan`);
			}
			const price = plan.basePrice;
			const displayedPrice = price
				? `$${price.amountUsd.toLocaleString()}/${
						price.interval === 'month' ? 'mo' : 'yr'
					}`
				: 'Free';
			const displayedPricePerMonth =
				price && price.interval === 'year'
					? `$${Math.round(price.amountUsd / 12)}/mo`
					: displayedPrice;

			const displayedCreditsPerCycle = `${plan.credits.grantedPerCycle.toLocaleString()} credits/mo`;
			const displayedOverage = plan.credits.overage
				? `$${formatUsd(plan.credits.overage.priceUsd)}/${plan.credits.overage.billingUnits} overage`
				: null;

			const eligibility = eligibilityByPlanId.get(planId);

			return {
				id: plan.id,
				displayName: plan.displayName.replace(' (Annual)', ''),
				displayedPrice,
				displayedPricePerMonth,
				displayedCreditsPerCycle,
				displayedOverage,
				rollover: plan.rollover,
				isRecommended: plan.isRecommended,
				cta: resolveCta(eligibility?.attachAction, eligibility?.status),
				isTrialing: eligibility?.trialing ?? false,
			};
		}

		const topUp = PLANS[PLAN_IDS.creditTopUp];

		return {
			cards: {
				monthly: VISIBLE_SUBSCRIPTION_PLAN_IDS.monthly.map(renderCard),
				annual: VISIBLE_SUBSCRIPTION_PLAN_IDS.annual.map(renderCard),
			},
			topUp: {
				creditsPerPurchase: topUp.creditsPerPurchase,
				priceUsd: topUp.priceUsd,
			},
		};
	}

	async function listUsage(query: UsageQuery): Promise<UsageSeries> {
		const result = await autumn.events.aggregate({
			customerId: identity.userId,
			featureId: FEATURE_IDS.aiUsage,
			range: query.range,
			binSize: query.binSize,
			groupBy:
				query.groupBy === 'model'
					? 'properties.model'
					: query.groupBy === 'provider'
						? 'properties.provider'
						: undefined,
			maxGroups: query.maxGroups,
		});

		const total = result.total?.[FEATURE_IDS.aiUsage];
		return {
			totalCredits: total?.sum ?? 0,
			totalCalls: total?.count ?? 0,
			buckets: (result.list ?? []).map((period) => ({
				periodIso: new Date(period.period).toISOString(),
				groupedCredits: period.groupedValues?.[FEATURE_IDS.aiUsage] ?? {},
			})),
		};
	}

	async function listEvents(query: EventsQuery): Promise<BillingEventsPage> {
		const result = await autumn.events.list({
			customerId: identity.userId,
			featureId: FEATURE_IDS.aiUsage,
			limit: query.limit,
		});

		const events: BillingEvent[] = (result.list ?? []).map((e) => {
			const props = (e.properties ?? {}) as Record<string, unknown>;
			return {
				id: e.id,
				timestampMs: e.timestamp,
				model: typeof props.model === 'string' ? props.model : null,
				provider: typeof props.provider === 'string' ? props.provider : null,
				credits: e.value,
			};
		});

		return { events };
	}

	async function previewPlanChange(input: {
		planId: string;
	}): Promise<PlanChangePreview> {
		const preview = await autumn.billing.previewAttach({
			customerId: identity.userId,
			planId: input.planId,
		});
		// Autumn returns `total` in cents.
		const prorationAmountUsd = (preview.total ?? 0) / 100;
		const displayedSummary =
			prorationAmountUsd > 0
				? `You will be charged $${formatUsd(prorationAmountUsd)} today (prorated).`
				: 'No charge today. Plan changes take effect at the next renewal.';
		return { displayedSummary };
	}

	async function checkoutPlan(input: {
		planId: CheckoutPlanId;
		successUrl?: string | undefined;
	}): Promise<CheckoutResult> {
		// Rollover plans carry the credit wallet across the upgrade. The
		// catalog answers "is this a rollover plan" so route handlers
		// don't ship hard-coded plan-id lists.
		const target = getPlan(input.planId);
		const carry =
			target && target.kind === 'subscription' && target.rollover
				? { enabled: true, featureIds: [FEATURE_IDS.aiCredits] }
				: undefined;

		const result = await autumn.billing.attach({
			customerId: identity.userId,
			planId: input.planId,
			successUrl: input.successUrl,
			...(carry ? { carryOverBalances: carry } : {}),
		});
		return { checkoutUrl: result.paymentUrl };
	}

	async function checkoutTopUp(input: {
		successUrl?: string | undefined;
	}): Promise<CheckoutResult> {
		const result = await autumn.billing.attach({
			customerId: identity.userId,
			planId: PLAN_IDS.creditTopUp,
			successUrl: input.successUrl,
		});
		return { checkoutUrl: result.paymentUrl };
	}

	async function openPortal(input: {
		returnUrl: string;
	}): Promise<PortalSession> {
		const result = await autumn.billing.openCustomerPortal({
			customerId: identity.userId,
			returnUrl: input.returnUrl,
		});
		return { portalUrl: result.url };
	}

	// ----- Private helpers (closed over `autumn`/`identity`) ------------

	/** Finalize a held lock. Both reservation kinds share this. */
	function finalizeLock(
		lockId: string,
		action: 'confirm' | 'release',
	): Promise<Result<void, BillingError>> {
		return tryAutumn(async () => {
			await autumn.balances.finalize({ lockId, action });
		});
	}

	/** Load Autumn customer with subscriptions + balances expanded. */
	async function loadCustomer() {
		return autumn.customers.getOrCreate({
			customerId: identity.userId,
			email: identity.userEmail,
			expand: ['subscriptions.plan', 'balances.feature'],
		});
	}

	return {
		reserveAiChat,
		reserveAssetStorage,
		creditAssetStorage,
		getOverview,
		listPlans,
		listUsage,
		listEvents,
		previewPlanChange,
		checkoutPlan,
		checkoutTopUp,
		openPortal,
	};
}

function formatUsd(amount: number): string {
	return Number.isInteger(amount) ? `${amount}` : amount.toFixed(2);
}

/**
 * Map Autumn's per-plan eligibility to a dashboard CTA. Autumn is the single
 * owner of the customer's relationship to a plan: `attachAction` says what
 * attaching would do, and the inert `none` case splits on `status` (the active
 * plan vs a scheduled change to it). `attachAction` is an open enum, so an
 * unrecognized value falls back to the generic actionable 'Switch' rather than
 * silently masquerading as 'Current'.
 */
function resolveCta(
	attachAction: string | undefined,
	status: string | undefined,
): BillingPlanCard['cta'] {
	switch (attachAction) {
		case 'none':
			return status === 'scheduled' ? 'Scheduled' : 'Current';
		case 'upgrade':
			return 'Upgrade';
		case 'downgrade':
			return 'Downgrade';
		default:
			return 'Switch';
	}
}
