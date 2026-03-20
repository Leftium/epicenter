import { feature, item, plan } from 'atmn';

// ---------------------------------------------------------------------------
// Metered features — one per model class
// ---------------------------------------------------------------------------

export const aiChatFast = feature({
	id: 'ai-chat-fast',
	name: 'AI Chat (Fast)',
	type: 'metered',
	consumable: true,
});

export const aiChatSmart = feature({
	id: 'ai-chat-smart',
	name: 'AI Chat (Smart)',
	type: 'metered',
	consumable: true,
});

export const aiChatPremium = feature({
	id: 'ai-chat-premium',
	name: 'AI Chat (Premium)',
	type: 'metered',
	consumable: true,
});

// ---------------------------------------------------------------------------
// Credit system — single pool, different costs per model class
// ---------------------------------------------------------------------------

export const aiCredits = feature({
	id: 'ai-credits',
	name: 'AI Credits',
	type: 'credit_system',
	creditSchema: [
		{ meteredFeatureId: aiChatFast.id, creditCost: 1 },
		{ meteredFeatureId: aiChatSmart.id, creditCost: 3 },
		{ meteredFeatureId: aiChatPremium.id, creditCost: 10 },
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

/** One-time credit top-up add-on. 500 credits for $5. */
export const creditTopUp = plan({
	id: 'credit-top-up',
	name: 'Credit Top-Up',
	addOn: true,
	items: [
		item({
			featureId: aiCredits.id,
			price: {
				amount: 5,
				billingUnits: 500,
				billingMethod: 'prepaid',
			},
		}),
	],
});
