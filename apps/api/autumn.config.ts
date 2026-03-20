import { feature, item, plan } from 'atmn';

// ---------------------------------------------------------------------------
// Metered features — one per model tier
// ---------------------------------------------------------------------------

export const aiFast = feature({
	id: 'ai_fast',
	name: 'AI (Fast)',
	type: 'metered',
	consumable: true,
});

export const aiStandard = feature({
	id: 'ai_standard',
	name: 'AI (Standard)',
	type: 'metered',
	consumable: true,
});

export const aiPremium = feature({
	id: 'ai_premium',
	name: 'AI (Premium)',
	type: 'metered',
	consumable: true,
});

// ---------------------------------------------------------------------------
// Credit system — single pool, different costs per model tier
// ---------------------------------------------------------------------------

export const aiCredits = feature({
	id: 'ai_credits',
	name: 'AI Credits',
	type: 'credit_system',
	creditSchema: [
		{ meteredFeatureId: aiFast.id, creditCost: 1 },
		{ meteredFeatureId: aiStandard.id, creditCost: 3 },
		{ meteredFeatureId: aiPremium.id, creditCost: 10 },
	],
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
