/**
 * Billing service.
 *
 * Owns every Autumn round-trip in the cloud worker. Routes and gates
 * call into this service, which returns Epicenter DTOs from
 * `@epicenter/billing/contracts`. Nothing outside this module imports
 * `autumn-js` at runtime.
 *
 * Lifecycle: one service per request. Construct via
 * `createBillingService(env, { userId, userEmail })`. The service does
 * NOT cache the customer across calls; each public method makes the
 * Autumn calls it needs and returns a DTO.
 */

import {
	FEATURE_IDS,
	FREE_TIER_MAX_CREDITS_PER_CALL,
	getPlan,
	isOneOffTopUpPlan,
	isSubscriptionPlan,
	PLAN_IDS,
	PLANS,
	type PlanId,
	RECOMMENDED_PLAN_IDS,
	TOP_UP_PLAN_ID,
	VISIBLE_SUBSCRIPTION_PLAN_IDS,
} from '@epicenter/billing/catalog';
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
} from '@epicenter/billing/contracts';
import { MODEL_CREDITS } from '@epicenter/billing/ai-model-pricing';
import { AiChatError } from '@epicenter/constants/ai-chat-errors';
import { AssetError } from '@epicenter/constants/asset-errors';
import type { Err } from 'wellcrafted/result';
import { type AutumnClient, createAutumn } from './autumn-client.js';

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

type Identity = {
	userId: string;
	userEmail: string | null;
};

/** Body shapes are wellcrafted Err envelopes (`{ data: null, error }`)
 *  ready to be handed to `c.json(...)` for the wire response. */
type AiErrorBody = Err<
	| ReturnType<typeof AiChatError.UnknownModel>['error']
	| ReturnType<typeof AiChatError.ModelRequiresPaidPlan>['error']
	| ReturnType<typeof AiChatError.InsufficientCredits>['error']
>;

type StorageErrorBody = Err<
	ReturnType<typeof AssetError.StorageLimitExceeded>['error']
>;

/** Result of an AI billing gate check. */
export type AiGateOutcome =
	| { kind: 'allow'; credits: number }
	| { kind: 'deny'; status: 400 | 402 | 403; body: AiErrorBody };

/** Result of a pre-flight storage upload check. */
export type StorageGateOutcome =
	| { kind: 'allow' }
	| { kind: 'deny'; status: 402; body: StorageErrorBody };

// ---------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------

export function createBillingService(
	env: { AUTUMN_SECRET_KEY: string },
	identity: Identity,
) {
	const autumn = createAutumn(env);
	return new BillingService(autumn, identity);
}

export class BillingService {
	constructor(
		private readonly autumn: AutumnClient,
		private readonly identity: Identity,
	) {}

	// ----- Customer + plan resolution -----------------------------------

	/** Load Autumn customer with subscriptions + balances expanded. */
	private async loadCustomer() {
		return this.autumn.customers.getOrCreate({
			customerId: this.identity.userId,
			email: this.identity.userEmail ?? undefined,
			expand: ['subscriptions.plan', 'balances.feature'],
		});
	}

	/** Find the active non-add-on subscription. Returns null when the
	 *  customer only has add-ons (e.g. top-ups) or no subscriptions. */
	private mainSubscriptionOf(
		subscriptions: Array<{
			addOn: boolean;
			planId: string;
			plan?: { name?: string };
			trialEndsAt: number | null;
		}>,
	) {
		return subscriptions.find((s) => !s.addOn) ?? null;
	}

	// ----- AI gate ------------------------------------------------------

	/** Resolve credit cost, plan eligibility, and atomically deduct.
	 *  Returns the credit count so the gate can refund on failure. */
	async guardAiChat(input: {
		model: string;
		provider: string | undefined;
	}): Promise<AiGateOutcome> {
		const credits = MODEL_CREDITS[input.model as keyof typeof MODEL_CREDITS];
		if (credits === undefined) {
			return {
				kind: 'deny',
				status: 400,
				body: AiChatError.UnknownModel({ model: input.model }),
			};
		}

		// Resolve the active plan from a single customer fetch.
		const customer = await this.loadCustomer();
		const mainSub = this.mainSubscriptionOf(customer.subscriptions);
		const planId = mainSub?.planId ?? PLAN_IDS.free;

		// Free tier rejects models above the per-call ceiling.
		if (planId === PLAN_IDS.free && credits > FREE_TIER_MAX_CREDITS_PER_CALL) {
			return {
				kind: 'deny',
				status: 403,
				body: AiChatError.ModelRequiresPaidPlan({
					model: input.model,
					credits,
				}),
			};
		}

		// Atomic check + deduct. `sendEvent: true` makes Autumn record the
		// usage as part of the same call, so a second concurrent request
		// cannot read the same balance.
		const { allowed, balance } = await this.autumn.check({
			customerId: this.identity.userId,
			featureId: FEATURE_IDS.aiUsage,
			requiredBalance: credits,
			sendEvent: true,
			withPreview: true,
			properties: { model: input.model, provider: input.provider },
		});

		if (!allowed) {
			return {
				kind: 'deny',
				status: 402,
				body: AiChatError.InsufficientCredits({ balance }),
			};
		}

		return { kind: 'allow', credits };
	}

	/** Refund a previously-deducted AI charge. Returns a promise the
	 *  caller can queue via afterResponse so the response stays fast. */
	refundAiCharge(credits: number): Promise<unknown> {
		return this.autumn.track({
			customerId: this.identity.userId,
			featureId: FEATURE_IDS.aiUsage,
			value: -credits,
		});
	}

	// ----- Storage gate -------------------------------------------------

	/** Pre-flight check for an asset upload against the storage budget. */
	async guardAssetUpload(fileSize: number): Promise<StorageGateOutcome> {
		// `customers.getOrCreate` ensures the customer exists before the
		// check; for new customers the storage balance must be seeded
		// from the auto-enable free plan.
		await this.autumn.customers.getOrCreate({
			customerId: this.identity.userId,
			email: this.identity.userEmail ?? undefined,
		});

		const { allowed } = await this.autumn.check({
			customerId: this.identity.userId,
			featureId: FEATURE_IDS.storageBytes,
			requiredBalance: fileSize,
		});

		if (!allowed) {
			return {
				kind: 'deny',
				status: 402,
				body: AssetError.StorageLimitExceeded({ requestedBytes: fileSize }),
			};
		}
		return { kind: 'allow' };
	}

	/** Record storage usage after a successful upload. */
	trackAssetUpload(sizeBytes: number): Promise<unknown> {
		return this.autumn.track({
			customerId: this.identity.userId,
			featureId: FEATURE_IDS.storageBytes,
			value: sizeBytes,
		});
	}

	/** Release storage usage after a successful delete. */
	releaseAssetStorage(sizeBytes: number): Promise<unknown> {
		return this.autumn.track({
			customerId: this.identity.userId,
			featureId: FEATURE_IDS.storageBytes,
			value: -sizeBytes,
		});
	}

	// ----- Dashboard data plane -----------------------------------------

	async getOverview(): Promise<BillingOverview> {
		const customer = await this.loadCustomer();
		const mainSub = this.mainSubscriptionOf(customer.subscriptions);
		const planId = mainSub?.planId ?? PLAN_IDS.free;
		const catalogPlan = getPlan(planId);
		const planDisplayName =
			mainSub?.plan?.name ??
			(catalogPlan ? catalogPlan.displayName : planId);

		const trial =
			mainSub?.trialEndsAt != null
				? {
						endsAtMs: mainSub.trialEndsAt,
						daysLeft: daysUntil(mainSub.trialEndsAt),
					}
				: null;

		const creditsBalance = customer.balances?.[FEATURE_IDS.aiCredits];
		const monthlyEntry = creditsBalance?.breakdown?.find(
			(e) => e.reset?.interval === 'month',
		);
		const rolloverEntry = creditsBalance?.rollovers?.[0];

		const storageBalance = customer.balances?.[FEATURE_IDS.storageBytes];

		return {
			planId,
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
				includedBytes:
					storageBalance?.granted ??
					(catalogPlan && isSubscriptionPlan(catalogPlan)
						? catalogPlan.storage.includedBytes
						: 0),
			},
		};
	}

	async listPlans(): Promise<BillingPlansView> {
		const [customer, autumnPlans] = await Promise.all([
			this.loadCustomer(),
			this.autumn.plans.list({ customerId: this.identity.userId }),
		]);

		const eligibilityByPlanId = new Map(
			(autumnPlans.list ?? []).map(
				(p) => [p.id, p.customerEligibility?.attachAction] as const,
			),
		);

		const mainSub = this.mainSubscriptionOf(customer.subscriptions);
		const currentPlanId = mainSub?.planId ?? PLAN_IDS.free;
		const currentPlan = getPlan(currentPlanId);
		const currentPlanDisplayName =
			mainSub?.plan?.name ??
			(currentPlan ? currentPlan.displayName : currentPlanId);

		const renderCard = (planId: PlanId): BillingPlanCard => {
			const plan = PLANS[planId];
			if (!isSubscriptionPlan(plan)) {
				// Subscription cards never include the top-up plan; this is
				// a programmer error in VISIBLE_SUBSCRIPTION_PLAN_IDS.
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

			const isCurrent =
				currentPlanId === planId ||
				// Annual cards highlight the matching monthly subscription
				// (and vice versa) so the user can see which cycle they are on.
				(plan.monthlyEquivalentId !== null &&
					plan.monthlyEquivalentId === currentPlanId);

			let cta: BillingPlanCard['cta'];
			if (isCurrent) {
				cta = { kind: 'current' };
			} else {
				const action = eligibilityByPlanId.get(planId);
				const verb =
					action === 'upgrade'
						? 'Upgrade'
						: action === 'downgrade'
							? 'Downgrade'
							: 'Switch';
				cta = { kind: 'switch', verb };
			}

			return {
				id: plan.id,
				displayName: plan.displayName.replace(' (Annual)', ''),
				cycle: plan.cycle,
				displayedPrice,
				displayedPricePerMonth,
				displayedCreditsPerCycle,
				displayedOverage,
				rollover: plan.rollover,
				isRecommended: RECOMMENDED_PLAN_IDS.has(plan.id),
				cta,
				isTrialing:
					mainSub?.trialEndsAt != null && mainSub.planId === plan.id,
			};
		};

		const topUp = PLANS[TOP_UP_PLAN_ID];
		if (!isOneOffTopUpPlan(topUp)) {
			throw new Error('TOP_UP_PLAN_ID must reference a one-off plan');
		}

		return {
			currentPlanId,
			currentPlanDisplayName,
			cards: {
				monthly: VISIBLE_SUBSCRIPTION_PLAN_IDS.monthly.map(renderCard),
				annual: VISIBLE_SUBSCRIPTION_PLAN_IDS.annual.map(renderCard),
			},
			topUp: {
				planId: topUp.id,
				creditsPerPurchase: topUp.creditsPerPurchase,
				priceUsd: topUp.priceUsd,
			},
		};
	}

	async listUsage(query: UsageQuery): Promise<UsageSeries> {
		const result = await this.autumn.events.aggregate({
			customerId: this.identity.userId,
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

	async listEvents(query: EventsQuery): Promise<BillingEventsPage> {
		// Autumn `events.list` uses offset pagination, not cursors. We
		// expose the next-page offset as the `nextCursor` string so the
		// dashboard contract stays cursor-shaped (offset is an Autumn
		// detail; switching to a true cursor later would not change
		// the dashboard contract).
		const offset = query.startingAfter
			? Number.parseInt(query.startingAfter, 10) || 0
			: 0;
		const result = await this.autumn.events.list({
			customerId: this.identity.userId,
			featureId: FEATURE_IDS.aiUsage,
			limit: query.limit,
			offset,
		});

		const events: BillingEvent[] = (result.list ?? []).map((e) => {
			const props = (e.properties ?? {}) as Record<string, unknown>;
			const model = typeof props.model === 'string' ? props.model : null;
			const provider =
				typeof props.provider === 'string' ? props.provider : null;
			return {
				id: e.id,
				timestampMs: e.timestamp,
				model,
				provider,
				credits: e.value,
			};
		});

		return {
			events,
			nextCursor: result.hasMore ? String(offset + events.length) : null,
		};
	}

	async previewPlanChange(planId: string): Promise<PlanChangePreview> {
		const preview = await this.autumn.billing.previewAttach({
			customerId: this.identity.userId,
			planId,
		});
		// Autumn returns `total` in cents.
		const prorationAmountUsd = (preview.total ?? 0) / 100;
		const displayedSummary =
			prorationAmountUsd > 0
				? `You will be charged $${formatUsd(prorationAmountUsd)} today (prorated).`
				: 'No charge today. Plan changes take effect at the next renewal.';
		return { prorationAmountUsd, displayedSummary };
	}

	async checkoutPlan(input: {
		planId: string;
		successUrl?: string | undefined;
	}): Promise<CheckoutResult> {
		// Rollover plans carry the credit wallet across the upgrade. The
		// catalog answers "is this a rollover plan" so route handlers
		// don't ship hard-coded plan-id lists.
		const target = getPlan(input.planId);
		const carry =
			target && isSubscriptionPlan(target) && target.rollover
				? {
						enabled: true,
						featureIds: [FEATURE_IDS.aiCredits],
					}
				: undefined;

		const result = await this.autumn.billing.attach({
			customerId: this.identity.userId,
			planId: input.planId,
			successUrl: input.successUrl,
			...(carry ? { carryOverBalances: carry } : {}),
		});
		return { checkoutUrl: result.paymentUrl };
	}

	async checkoutTopUp(input: {
		successUrl?: string | undefined;
	}): Promise<CheckoutResult> {
		const result = await this.autumn.billing.attach({
			customerId: this.identity.userId,
			planId: TOP_UP_PLAN_ID,
			successUrl: input.successUrl,
		});
		return { checkoutUrl: result.paymentUrl };
	}

	async openPortal(input: { returnUrl: string }): Promise<PortalSession> {
		const result = await this.autumn.billing.openCustomerPortal({
			customerId: this.identity.userId,
			returnUrl: input.returnUrl,
		});
		return { portalUrl: result.url };
	}
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function daysUntil(epochMs: number): number {
	return Math.max(0, Math.ceil((epochMs - Date.now()) / 86_400_000));
}

function formatUsd(amount: number): string {
	return Number.isInteger(amount) ? `${amount}` : amount.toFixed(2);
}
