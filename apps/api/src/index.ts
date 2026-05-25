/**
 * Epicenter Cloud Worker entry.
 *
 * Composes the `@epicenter/server` library in `personal` ownership mode and
 * layers cloud-only billing, admin, and dashboard surfaces on top. Self-
 * hosted team deployments live in a sibling apps/* folder and compose the
 * same library with `mode: 'team'` and no Autumn middleware.
 *
 * Read top to bottom for the full URL surface of cloud.
 */

import {
	createAiApp,
	createAssetsApp,
	createAttachOwner,
	createAuthApp,
	createBaseApp,
	createRoomsApp,
	createSessionApp,
	Room,
	requireBearerUser,
	requireCookieOrBearerUser,
	requireUrlOwnerIdMatchesAuth,
} from '@epicenter/server';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import {
	autumnAiGate,
	autumnStorageGate,
	type Env,
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

// Auth surface (no /api prefix; these render HTML and OAuth metadata).
const auth = createAuthApp();
base.route('/sign-in', auth).route('/consent', auth).route('/auth', auth);

// Session: cookie-or-bearer auth + owner resolution, then library handler.
const cloudSession = new Hono<Env>()
	.use('/', requireCookieOrBearerUser, attachOwner)
	.route('/', createSessionApp());
base.route('/api/session', cloudSession);

// Rooms: bearer auth + URL ownerId safety + owner resolution, then library
// handler. No billing gate for rooms today; bandwidth and DO storage are not
// metered.
const cloudRooms = new Hono<Env>()
	.use(
		'/owners/:ownerId/rooms/*',
		requireBearerUser,
		requireUrlOwnerIdMatchesAuth,
		attachOwner,
	)
	.route('/', createRoomsApp());
base.route('/api', cloudRooms);

// Assets: split auth by path/method. POST upload, list, usage, PATCH metadata,
// and DELETE all require auth. The conditional GET at /:assetId is left
// uncovered; the library handler looks up the row and runs auth inline only
// for `visibility === 'private'` rows. Public assets serve to anyone with the
// URL.
const cloudAssets = new Hono<Env>()
	// POST upload + GET list at the bare prefix
	.use(
		'/owners/:ownerId/assets',
		requireCookieOrBearerUser,
		requireUrlOwnerIdMatchesAuth,
		attachOwner,
		autumnStorageGate,
	)
	// GET usage (one segment deeper, not caught by the bare-prefix .use)
	.use(
		'/owners/:ownerId/assets/usage',
		requireCookieOrBearerUser,
		requireUrlOwnerIdMatchesAuth,
		attachOwner,
		autumnStorageGate,
	)
	// PATCH metadata + DELETE on /:assetId. GET is intentionally absent
	// here so the conditional library handler can run without upstream auth.
	.on(
		['PATCH', 'DELETE'],
		'/owners/:ownerId/assets/:assetId{[a-z0-9]{21}}',
		requireCookieOrBearerUser,
		requireUrlOwnerIdMatchesAuth,
		attachOwner,
		autumnStorageGate,
	)
	.route('/', createAssetsApp({ mode: MODE }));
base.route('/api', cloudAssets);

// AI chat: bearer-only, plan-aware credit gate, then library handler.
const cloudAi = new Hono<Env>()
	.use('*', requireBearerUser, ensurePlanId, autumnAiGate)
	.route('/', createAiApp());
base.route('/api/ai', cloudAi);

// Billing dashboard data plane.
base.use('/api/billing/*', requireCookieOrBearerUser);
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
