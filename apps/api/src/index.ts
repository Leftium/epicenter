/**
 * Epicenter Cloud Worker entry.
 *
 * Composes the `@epicenter/server` library with the `personal` ownership
 * rule and layers cloud-only billing, admin, and dashboard surfaces on
 * top. Self-hosted team deployments live in a sibling apps/* folder and
 * compose the same library with `team({ isMember })` and no Autumn
 * middleware.
 *
 * Library sub-apps declare their full URL patterns (including `/api`).
 * The deployment composes auth + billing middleware via `base.use(...)` at
 * the matching pattern, then mounts each sub-app at `/`.
 *
 * Read top to bottom for the full URL surface of cloud.
 */

import { API_ROUTES } from '@epicenter/constants/api-routes';
import {
	aiApp,
	authApp,
	createBaseApp,
	createRequireOwnership,
	mountAssetsApp,
	mountRoomsApp,
	personal,
	Room,
	requireBearerUser,
	requireCookieOrBearerUser,
	sessionApp,
} from '@epicenter/server';
import { describeRoute } from 'hono-openapi';
import { autumnAiGate, autumnStorageGate } from './billing/gates.js';
import { billingRoutes } from './billing/routes.js';

const ownership = personal();

const base = createBaseApp();

// Public health endpoint at root.
base.get('/', (c) =>
	c.json({ mode: 'hub', version: '0.1.0', runtime: 'cloudflare' }),
);

// Auth surface (HTML pages + OAuth metadata; no /api prefix by design).
base.route('/', authApp);

// Session: cookie-or-bearer auth + owner resolution. No URL :ownerId; the
// guard attaches the resolved partition directly.
base.use(
	API_ROUTES.session.pattern,
	requireCookieOrBearerUser,
	createRequireOwnership(ownership),
);
base.route('/', sessionApp);

// Rooms: library owns the URL pattern, bearer auth, and ownership boundary.
// No billing gate; bandwidth and DO storage are not metered.
mountRoomsApp(base, { ownership });

// Assets: library owns the URL/auth matrix; we layer the cloud-only
// storage gate. The conditional public-read GET is excluded from the
// gate by the mount helper.
mountAssetsApp(base, { ownership, gates: [autumnStorageGate] });

// AI chat: bearer-only, plan-aware credit gate. The gate fetches the
// customer, resolves the active plan, and atomically deducts credits
// inside one billing-service call.
base.use(API_ROUTES.ai.chat.prefixPattern, requireBearerUser, autumnAiGate);
base.route('/', aiApp);

// Billing dashboard data plane.
base.use(API_ROUTES.billing.prefixPattern, requireCookieOrBearerUser);
base.route('/api/billing', billingRoutes);

// Dashboard SPA: Workers Static Assets binding serves the SvelteKit build.
base.on(
	'GET',
	['/dashboard', '/dashboard/*'],
	describeRoute({
		description: 'Dashboard SPA static fallback',
		tags: ['dashboard'],
	}),
	async (c) => {
		const assetsFetcher = c.env.ASSETS;
		if (!assetsFetcher) return c.notFound();
		const indexUrl = new URL('/dashboard/index.html', c.req.url);
		return assetsFetcher.fetch(new Request(indexUrl.toString(), c.req.raw));
	},
);

// Legacy redirect: /billing -> /dashboard.
base.get('/billing', (c) => c.redirect('/dashboard'));

/** App type for hc<AppType> in the dashboard. */
export type AppType = typeof base;

export default base;
export { Room };
