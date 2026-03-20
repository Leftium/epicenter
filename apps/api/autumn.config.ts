import { feature, item, plan } from 'atmn';

// ---------------------------------------------------------------------------
// Single metered feature for all AI usage — cost varies per model at runtime
// ---------------------------------------------------------------------------

export const aiUsage = feature({
	id: 'ai_usage',
	name: 'AI Usage',
	type: 'metered',
	consumable: true,
});

// ---------------------------------------------------------------------------
// Credit system — 1:1 mapping, actual cost determined at runtime
// ---------------------------------------------------------------------------

export const aiCredits = feature({
	id: 'ai_credits',
	name: 'AI Credits',
	type: 'credit_system',
	creditSchema: [{ meteredFeatureId: aiUsage.id, creditCost: 1 }],
});

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

/** Free — auto-assigned to every new customer. 50 credits/month. */
export const free = plan({
	id: 'free',
	name: 'Free',
	group: 'main',
	autoEnable: true,
	items: [
		item({
			featureId: aiCredits.id,
			included: 50,
			reset: { interval: 'month' },
		}),
	],
});

/** Pro — $20/month, 2000 credits + usage-based overage at $1/100 credits. */
export const pro = plan({
	id: 'pro',
	name: 'Pro',
	group: 'main',
	price: { amount: 20, interval: 'month' },
	items: [
		item({
			featureId: aiCredits.id,
			included: 2000,
			price: {
				amount: 1,
				billingUnits: 100,
				billingMethod: 'usage_based',
				interval: 'month',
			},
		}),
	],
});

/** Max — $100/month, 15000 credits + usage-based overage at $0.50/100 credits. */
export const max = plan({
	id: 'max',
	name: 'Max',
	group: 'main',
	price: { amount: 100, interval: 'month' },
	items: [
		item({
			featureId: aiCredits.id,
			included: 15000,
			price: {
				amount: 0.5,
				billingUnits: 100,
				billingMethod: 'usage_based',
				interval: 'month',
			},
		}),
	],
});

/** One-time credit top-up add-on. 500 credits for $5. */
export const creditTopUp = plan({
	id: 'credit_top_up',
	name: 'Credit Top-Up',
	addOn: true,
	items: [
		item({
			featureId: aiCredits.id,
			price: {
				amount: 5,
				billingUnits: 500,
				billingMethod: 'prepaid',
				interval: 'month',
			},
		}),
	],
});
