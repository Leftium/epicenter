/**
 * `/api/billing/*` routes for the dashboard.
 *
 * Every handler is a one-line delegate to `BillingService`. The service
 * owns Autumn round-trips and DTO mapping; routes own HTTP shape, body
 * validation, and the Autumn-error translation layer. Auth is mounted
 * in the parent composition (cloud's cookie-or-bearer middleware).
 */

import { BillingError } from '@epicenter/constants/billing-errors';
import { sValidator } from '@hono/standard-validator';
import { AutumnError } from 'autumn-js';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from './gates.js';
import {
	checkoutPlanSchema,
	checkoutTopUpSchema,
	eventsQuerySchema,
	previewPlanSchema,
	usageQuerySchema,
} from './schemas.js';
import { getModelCostGuide } from './model-cost-guide.js';
import { createBillingService } from './service.js';

const billingRoutes = new Hono<Env>();

/** Normalize `AutumnError.body` (raw HTTP body string) into `{code, message}`.
 *  Non-JSON bodies fall through as `{ code: undefined, message: <raw> }`
 *  so upstream text is never silently dropped. */
function parseAutumnBody(body: string): {
	code: string | undefined;
	message: string;
} {
	try {
		const parsed = JSON.parse(body) as unknown;
		if (parsed && typeof parsed === 'object') {
			const record = parsed as { code?: unknown; message?: unknown };
			return {
				code: typeof record.code === 'string' ? record.code : undefined,
				message: typeof record.message === 'string' ? record.message : body,
			};
		}
	} catch {
		// fall through to raw body
	}
	return { code: undefined, message: body };
}

// Translate Autumn SDK throws into the repo-wide wellcrafted envelope.
// Non-AutumnError throws (network failures, programming errors) bubble
// to the parent app's default handler for a generic 500.
billingRoutes.onError((err, c) => {
	if (!(err instanceof AutumnError)) throw err;
	const { code, message } = parseAutumnBody(err.body);
	return c.json(
		BillingError.ProviderRequestFailed({
			statusCode: err.statusCode,
			code,
			message,
		}),
		err.statusCode as ContentfulStatusCode,
	);
});

function svc(c: { env: Env['Bindings']; var: Env['Variables'] }) {
	return createBillingService(c.env, {
		userId: c.var.user.id,
		userEmail: c.var.user.email ?? null,
	});
}

// ── Overview (balance + plan + storage) ──────────────────────────────
billingRoutes.get('/overview', async (c) => c.json(await svc(c).getOverview()));

// ── Usage aggregation (powers charts) ────────────────────────────────
billingRoutes.post(
	'/usage',
	sValidator('json', usageQuerySchema),
	async (c) => c.json(await svc(c).listUsage(c.req.valid('json'))),
);

// ── Event history (powers activity feed) ─────────────────────────────
billingRoutes.post(
	'/events',
	sValidator('json', eventsQuerySchema),
	async (c) => c.json(await svc(c).listEvents(c.req.valid('json'))),
);

// ── Plan cards (powers Upgrade UI) ───────────────────────────────────
billingRoutes.get('/plans', async (c) => c.json(await svc(c).listPlans()));

// ── Static model cost guide ──────────────────────────────────────────
billingRoutes.get('/models', (c) => c.json(getModelCostGuide()));

// ── Preview a plan change ────────────────────────────────────────────
billingRoutes.post(
	'/preview',
	sValidator('json', previewPlanSchema),
	async (c) => {
		const { planId } = c.req.valid('json');
		return c.json(await svc(c).previewPlanChange(planId));
	},
);

// ── Checkout a subscription plan change ──────────────────────────────
billingRoutes.post(
	'/checkout/plan',
	sValidator('json', checkoutPlanSchema),
	async (c) => c.json(await svc(c).checkoutPlan(c.req.valid('json'))),
);

// ── Checkout a credit top-up ─────────────────────────────────────────
billingRoutes.post(
	'/checkout/top-up',
	sValidator('json', checkoutTopUpSchema),
	async (c) => c.json(await svc(c).checkoutTopUp(c.req.valid('json'))),
);

// ── Open the Stripe portal ───────────────────────────────────────────
billingRoutes.get('/portal', async (c) => {
	const returnUrl =
		c.req.query('returnUrl') ?? new URL('/dashboard', c.req.url).toString();
	return c.json(await svc(c).openPortal({ returnUrl }));
});

export { billingRoutes };
