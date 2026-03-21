import { Hono } from 'hono';
import { csrf } from 'hono/csrf';
import type { Env } from './app';
import { createAutumn } from './autumn';

const billing = new Hono<Env>();

// CSRF protection — blocks form POSTs from other origins via Origin/Sec-Fetch-Site header check.
billing.use(csrf());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Plan IDs to display, in order. Filters out add-ons and archived plans. */
const MAIN_PLAN_IDS = ['free', 'pro', 'max'] as const;

/** Format a plan's price for display. */
function formatPrice(price: { amount: number; interval: string } | null): string {
	if (!price || price.amount === 0) return '$0';
	return `$${price.amount}/${price.interval}`;
}

/** Format a plan item's credit info for display. */
function formatCredits(item: { included: number } | undefined): string {
	if (!item) return 'No credits';
	return `${item.included.toLocaleString()} credits/mo`;
}

/** Format overage pricing for display. */
function formatOverage(item: { price: { amount?: number; billingUnits: number } | null } | undefined): string {
	if (!item?.price?.amount) return 'No overage';
	return `$${item.price.amount} per ${item.price.billingUnits} extra`;
}

function formatDate(timestamp: number | null | undefined): string {
	if (!timestamp) return '—';
	return new Date(timestamp * 1000).toLocaleDateString('en-US', {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
	});
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function Layout({
	children,
	title,
	flash,
	redirectAfter,
}: {
	children: unknown;
	title?: string;
	flash?: { type: 'success' | 'error'; message: string };
	/** Auto-redirect after N seconds: [seconds, url] */
	redirectAfter?: [number, string];
}) {
	return (
		<html lang="en" class="dark">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1.0" />
				<title>{title ? `${title} — Epicenter` : 'Billing — Epicenter'}</title>
				{redirectAfter && (
					<meta http-equiv="refresh" content={`${redirectAfter[0]};url=${redirectAfter[1]}`} />
				)}
				<script src="https://cdn.tailwindcss.com"></script>
				<style>{`
					body { font-family: system-ui, -apple-system, sans-serif; }
					.credit-bar { background: #27272a; border-radius: 6px; overflow: hidden; height: 8px; }
					.credit-fill { background: #10b981; height: 100%; transition: width 0.3s; border-radius: 6px; }
				`}</style>
			</head>
			<body class="bg-zinc-950 text-zinc-100 min-h-screen">
				<div class="max-w-4xl mx-auto px-6 py-12">
					<header class="mb-10">
						<h1 class="text-2xl font-semibold tracking-tight">Billing</h1>
						<p class="text-zinc-400 mt-1 text-sm">
							Manage your plan, credits, and payment methods.
						</p>
					</header>

					{flash && (
						<div
							class={`mb-6 px-4 py-3 rounded-lg text-sm ${
								flash.type === 'success'
									? 'bg-emerald-950 text-emerald-200 border border-emerald-800'
									: 'bg-red-950 text-red-200 border border-red-800'
							}`}
						>
							{flash.message}
						</div>
					)}

					{children}
				</div>
			</body>
		</html>
	);
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function CreditBalance({
	balance,
	included,
	resetsAt,
}: {
	balance: number;
	included: number;
	resetsAt: string | null;
}) {
	const pct =
		included > 0 ? Math.min(100, Math.round((balance / included) * 100)) : 0;
	return (
		<section class="mb-10">
			<h2 class="text-lg font-medium mb-3">Credits</h2>
			<div class="bg-zinc-900 rounded-xl p-5 border border-zinc-800">
				<div class="flex items-baseline justify-between mb-3">
					<span class="text-2xl font-semibold tabular-nums">
						{balance.toLocaleString()}
					</span>
					<span class="text-zinc-400 text-sm">
						of {included.toLocaleString()} included
					</span>
				</div>
				<div class="credit-bar">
					<div class="credit-fill" style={`width: ${pct}%`} />
				</div>
				{resetsAt && (
					<p class="text-zinc-500 text-xs mt-2">Resets {resetsAt}</p>
				)}
			</div>
		</section>
	);
}

function PlanCard({
	plan,
	isCurrent,
	eligibility,
}: {
	plan: { id: string; name: string; price: { amount: number; interval: string } | null; items: Array<{ included: number; price: { amount?: number; billingUnits: number } | null }> };
	isCurrent: boolean;
	eligibility: string | undefined;
}) {
	const creditItem = plan.items[0];
	const buttonLabel = isCurrent
		? 'Current plan'
		: eligibility === 'upgrade'
			? `Upgrade to ${plan.name}`
			: eligibility === 'downgrade'
				? `Downgrade to ${plan.name}`
				: eligibility === 'activate'
					? `Subscribe to ${plan.name}`
					: `Switch to ${plan.name}`;

	return (
		<div
			class={`rounded-xl border p-5 flex flex-col ${
				isCurrent
					? 'border-emerald-700 bg-emerald-950/30'
					: 'border-zinc-800 bg-zinc-900'
			}`}
		>
			<h3 class="text-lg font-semibold">{plan.name}</h3>
			<p class="text-2xl font-bold mt-1">{formatPrice(plan.price)}</p>
			<p class="text-zinc-400 text-sm mt-1">{formatCredits(creditItem)}</p>
			<p class="text-zinc-500 text-xs mt-0.5">{formatOverage(creditItem)}</p>
			<div class="mt-auto pt-4">
				{isCurrent ? (
					<button
						disabled
						class="w-full py-2 px-4 rounded-lg text-sm font-medium bg-zinc-800 text-zinc-500 cursor-not-allowed"
					>
						Current plan
					</button>
				) : (
					<form method="post" action="/billing/upgrade">
						<input type="hidden" name="planId" value={plan.id} />
						<button
							type="submit"
							class={`w-full py-2 px-4 rounded-lg text-sm font-medium transition-colors ${
								eligibility === 'upgrade'
									? 'bg-emerald-600 hover:bg-emerald-500 text-white'
									: 'bg-zinc-700 hover:bg-zinc-600 text-zinc-200'
							}`}
						>
							{buttonLabel}
						</button>
					</form>
				)}
			</div>
		</div>
	);
}

function SubscriptionSection({
	subscription,
}: {
	subscription: {
		planId: string;
		plan?: { name: string };
		status: string;
		canceledAt: number | null;
		expiresAt: number | null;
		currentPeriodEnd: number | null;
	} | null;
}) {
	if (!subscription || subscription.planId === 'free') return null;

	const isCanceled = subscription.canceledAt && subscription.canceledAt > 0;

	return (
		<section class="mb-10">
			<h2 class="text-lg font-medium mb-3">Subscription</h2>
			<div class="bg-zinc-900 rounded-xl p-5 border border-zinc-800">
				{isCanceled ? (
					<div class="flex items-center justify-between">
						<div>
							<p class="text-rose-300 text-sm">
								Cancels on{' '}
								{formatDate(subscription.expiresAt ?? subscription.currentPeriodEnd)}
							</p>
							<p class="text-zinc-500 text-xs mt-0.5">
								You'll lose access to paid features after this date.
							</p>
						</div>
						<form method="post" action="/billing/uncancel">
							<input type="hidden" name="planId" value={subscription.planId} />
							<button
								type="submit"
								class="py-2 px-4 rounded-lg text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white transition-colors"
							>
								Keep plan
							</button>
						</form>
					</div>
				) : (
					<div class="flex items-center justify-between">
						<div>
							<p class="text-sm">
								{subscription.plan?.name ?? subscription.planId}{' '}
								plan\u2014active
							</p>
							{subscription.currentPeriodEnd && (
								<p class="text-zinc-500 text-xs mt-0.5">
									Renews {formatDate(subscription.currentPeriodEnd)}
								</p>
							)}
						</div>
						<form method="post" action="/billing/cancel">
							<input type="hidden" name="planId" value={subscription.planId} />
							<button
								type="submit"
								class="py-2 px-4 rounded-lg text-sm font-medium bg-zinc-700 hover:bg-red-900 hover:text-red-200 text-zinc-300 transition-colors"
							>
								Cancel plan
							</button>
						</form>
					</div>
				)}
			</div>
		</section>
	);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** GET /billing — Main dashboard */
billing.get('/', async (c) => {
	const autumn = createAutumn(c.env);
	const userId = c.var.user.id;

	// Flash messages from query params
	const q = c.req.query();
	const FLASH_MESSAGES: Record<string, { type: 'success' | 'error'; message: string }> = {
		upgraded: { type: 'success', message: 'Plan upgraded successfully.' },
		canceled: { type: 'success', message: 'Subscription will cancel at the end of this billing cycle.' },
		uncanceled: { type: 'success', message: 'Cancellation reversed\u2014your plan stays active.' },
		topped_up: { type: 'success', message: 'Credits added to your account.' },
	};
	const flashKey = Object.keys(q).find((k) => k in FLASH_MESSAGES);
	const flash = q['error']
		? { type: 'error' as const, message: decodeURIComponent(q['error']!) }
		: flashKey
			? FLASH_MESSAGES[flashKey]
			: undefined;

	try {
		const [customer, plansResult] = await Promise.all([
			autumn.customers.getOrCreate({
				customerId: userId,
				name: c.var.user.name ?? undefined,
				email: c.var.user.email ?? undefined,
				expand: ['subscriptions.plan', 'balances.feature'],
			}),
			autumn.plans.list({ customerId: userId }),
		]);

		// Extract credit balance—SDK returns camelCase types
		const creditBalance = customer.balances['ai_credits'];
		const currentBalance = creditBalance?.remaining ?? 0;
		const resetsAt = creditBalance?.nextResetAt
			? formatDate(creditBalance.nextResetAt)
			: null;

		// Extract current subscription (non-addon = main plan)
		const mainSub = customer.subscriptions.find((s) => !s.addOn) ?? null;
		const currentPlanId = mainSub?.planId ?? 'free';	

		// Map plan eligibility from Autumn plans.list response
		const eligibilityMap = new Map<string, string>();
		for (const plan of plansResult.list) {
			if (plan.customerEligibility) {
				eligibilityMap.set(plan.id, plan.customerEligibility.attachAction);
			}
		}

		// Filter to main plans (non-addon), ordered by MAIN_PLAN_IDS
		const planMap = new Map(plansResult.list.map((p) => [p.id, p]));
		const mainPlans = MAIN_PLAN_IDS.map((id) => planMap.get(id)).filter((p) => p !== undefined);

		// Determine included credits based on current plan
		const includedCredits = creditBalance?.granted ?? 50;

		return c.html(
			<Layout flash={flash}>
				<CreditBalance
					balance={currentBalance}
					included={includedCredits}
					resetsAt={resetsAt}
				/>

				{/* Plan comparison */}
				<section class="mb-10">
					<h2 class="text-lg font-medium mb-3">Plans</h2>
					<div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
						{mainPlans.map((plan) => (
							<PlanCard
								plan={plan}
								isCurrent={currentPlanId === plan.id}
								eligibility={eligibilityMap.get(plan.id)}
							/>
						))}
					</div>
				</section>

				<SubscriptionSection subscription={mainSub} />

				{/* Top-up and portal */}
				<section class="flex flex-wrap gap-3">
					<form method="post" action="/billing/top-up">
						<button
							type="submit"
							class="py-2.5 px-5 rounded-lg text-sm font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 transition-colors"
						>
							Buy 500 credits — $5
						</button>
					</form>
					<a
						href="/billing/portal"
						class="inline-flex items-center py-2.5 px-5 rounded-lg text-sm font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 transition-colors"
					>
						Manage billing
					</a>
				</section>
			</Layout>,
		);
	} catch (err) {
		console.error('Billing dashboard error:', err);
		return c.html(
			<Layout
				flash={{
					type: 'error',
					message: 'Failed to load billing data. Try refreshing.',
				}}
			>
				<p class="text-zinc-500">
					Something went wrong loading your billing information.
				</p>
			</Layout>,
		);
	}
});

/** POST /billing/upgrade — Attach a plan */
billing.post('/upgrade', async (c) => {
	try {
		const body = await c.req.parseBody();
		const planId = body['planId'];
		if (typeof planId !== 'string') {
			return c.redirect('/billing?error=Missing+plan+ID');
		}

		const autumn = createAutumn(c.env);
		const result = await autumn.billing.attach({
			customerId: c.var.user.id,
			planId,
			successUrl: new URL('/billing/success', c.req.url).toString(),
		});

		if (result.paymentUrl) {
			return c.redirect(result.paymentUrl);
		}
		return c.redirect('/billing?upgraded=true');
	} catch (err) {
		console.error('Upgrade error:', err);
		return c.redirect('/billing?error=Upgrade+failed.+Please+try+again.');
	}
});

/** POST /billing/cancel — Cancel subscription at end of cycle */
billing.post('/cancel', async (c) => {
	try {
		const body = await c.req.parseBody();
		const planId = body['planId'];
		if (typeof planId !== 'string') {
			return c.redirect('/billing?error=Missing+plan+ID');
		}

		const autumn = createAutumn(c.env);
		await autumn.billing.update({
			customerId: c.var.user.id,
			planId,
			cancelAction: 'cancel_end_of_cycle',
		});

		return c.redirect('/billing?canceled=true');
	} catch (err) {
		console.error('Cancel error:', err);
		return c.redirect('/billing?error=Cancellation+failed.+Please+try+again.');
	}
});

/** POST /billing/uncancel — Reverse pending cancellation */
billing.post('/uncancel', async (c) => {
	try {
		const body = await c.req.parseBody();
		const planId = body['planId'];
		if (typeof planId !== 'string') {
			return c.redirect('/billing?error=Missing+plan+ID');
		}

		const autumn = createAutumn(c.env);
		await autumn.billing.update({
			customerId: c.var.user.id,
			planId,
			cancelAction: 'uncancel',
		});

		return c.redirect('/billing?uncanceled=true');
	} catch (err) {
		console.error('Uncancel error:', err);
		return c.redirect('/billing?error=Failed+to+reverse+cancellation.');
	}
});

/** GET /billing/portal — Redirect to Stripe customer portal */
billing.get('/portal', async (c) => {
	try {
		const autumn = createAutumn(c.env);
		const result = await autumn.billing.openCustomerPortal({
			customerId: c.var.user.id,
			returnUrl: new URL('/billing', c.req.url).toString(),
		});

		return c.redirect(result.url);
	} catch (err) {
		console.error('Portal error:', err);
		return c.redirect('/billing?error=Could+not+open+billing+portal.');
	}
});

/** POST /billing/top-up — Purchase credit top-up */
billing.post('/top-up', async (c) => {
	try {
		const autumn = createAutumn(c.env);
		const result = await autumn.billing.attach({
			customerId: c.var.user.id,
			planId: 'credit_top_up',
			successUrl: new URL('/billing/success', c.req.url).toString(),
		});

		if (result.paymentUrl) {
			return c.redirect(result.paymentUrl);
		}
		return c.redirect('/billing?topped_up=true');
	} catch (err) {
		console.error('Top-up error:', err);
		return c.redirect('/billing?error=Top-up+failed.+Please+try+again.');
	}
});

/** GET /billing/success — Post-checkout landing */
billing.get('/success', (c) => {
	return c.html(
		<Layout title="Payment successful" redirectAfter={[3, '/billing']}>
			<div class="text-center py-20">
				<div class="text-4xl mb-4">✓</div>
				<h2 class="text-xl font-semibold mb-2">Payment successful</h2>
				<p class="text-zinc-400 mb-6">Your account has been updated.</p>
				<a
					href="/billing"
					class="inline-flex py-2.5 px-5 rounded-lg text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white transition-colors"
				>
					Back to billing
				</a>
			</div>
		</Layout>,
	);
});

export { billing };
