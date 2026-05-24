/**
 * Epicenter Cloud Worker entry.
 *
 * Composes the `@epicenter/server` library in `personal` ownership mode and
 * layers cloud-only billing, admin, and dashboard surfaces on top. Self-
 * hosted team deployments live in a sibling apps/* folder and compose the
 * same library with `mode: 'team'` and no Autumn middleware.
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
	createAssetsApp,
	createAttachOwner,
	createBaseApp,
	Room,
	requireBearerUser,
	requireCookieOrBearerUser,
	requireUrlOwnerIdMatchesAuth,
	roomsApp,
	sessionApp,
} from '@epicenter/server';
import { describeRoute } from 'hono-openapi';
import {
	autumnAiGate,
	autumnStorageGate,
	ensurePlanId,
} from './autumn-gates.js';
import { billingRoutes } from './billing-routes.js';

const MODE = 'personal';

const base = createBaseApp({ signUpPolicy: 'open' });
const attachOwner = createAttachOwner(MODE);

// Public health endpoint at root.
base.get('/', (c) =>
	c.json({ mode: 'hub', version: '0.1.0', runtime: 'cloudflare' }),
);

// Auth surface (HTML pages + OAuth metadata; no /api prefix by design).
base.route('/', authApp);

// Session: cookie-or-bearer auth + owner resolution.
base.use(API_ROUTES.session.pattern, requireCookieOrBearerUser, attachOwner);
base.route('/', sessionApp);

// Rooms: bearer auth + URL ownerId safety + owner resolution. No billing
// gate; bandwidth and DO storage are not metered.
base.use(
	API_ROUTES.room.prefixPattern,
	requireBearerUser,
	requireUrlOwnerIdMatchesAuth,
	attachOwner,
);
base.route('/', roomsApp);

// Assets: split auth by path/method. POST upload, list, usage, PATCH metadata,
// and DELETE all require auth. The conditional GET at /:assetId is left
// uncovered; the library handler looks up the row and runs auth inline only
// for `visibility === 'private'` rows. Public assets serve to anyone with the
// URL.
base.use(
	API_ROUTES.assets.list.pattern,
	requireCookieOrBearerUser,
	requireUrlOwnerIdMatchesAuth,
	attachOwner,
	autumnStorageGate,
);
base.use(
	API_ROUTES.assets.usage.pattern,
	requireCookieOrBearerUser,
	requireUrlOwnerIdMatchesAuth,
	attachOwner,
	autumnStorageGate,
);
base.on(
	['PATCH', 'DELETE'],
	API_ROUTES.assets.byId.pattern,
	requireCookieOrBearerUser,
	requireUrlOwnerIdMatchesAuth,
	attachOwner,
	autumnStorageGate,
);
base.route('/', createAssetsApp({ mode: MODE }));

// AI chat: bearer-only, plan-aware credit gate.
base.use(API_ROUTES.ai.chat.prefixPattern, requireBearerUser, ensurePlanId, autumnAiGate);
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
