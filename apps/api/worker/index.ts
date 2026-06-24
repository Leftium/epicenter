/**
 * Epicenter Cloud Worker entry.
 *
 * Composes `@epicenter/server` with the `personal` ownership rule and
 * layers cloud-only billing, admin, and dashboard surfaces on top.
 * Self-hosted shared-wiki deployments live in a sibling apps/* folder and
 * compose the same library with `shared({ admit })` and no Autumn
 * policies.
 *
 * Read top to bottom for the full URL surface of cloud. Each `mount*`
 * call bundles the auth + ownership + policies + route mount for one
 * reusable surface; the deployment passes only the deployment-controlled
 * knobs (ownership rule, optional cloud policies, auth choice for AI).
 */

import { PRODUCTION_API_URL } from '@epicenter/constants/apps';
import {
	authApp,
	cloudflare,
	createServerApp,
	mountBlobsApp,
	mountInferenceApp,
	mountRoomsApp,
	mountSessionApp,
	personal,
	Room,
	requireBearerUser,
	requireCookieOrBearerUser,
	type ServerBindings,
} from '@epicenter/server';
import { describeRoute } from 'hono-openapi';
import { chargeOpenAiCreditsWithAutumn } from './billing/policies.js';
import { mountBillingApi } from './billing/routes.js';
import { buildEpicenterTrustedOrigins } from './trusted-origins.js';

// Compile-time proof that this worker's generated Env provides every
// binding the library reads. A missing or mistyped binding fails here,
// not deep inside library files compiled in this program.
({}) as Cloudflare.Env satisfies ServerBindings;

const ownership = personal();

const app = createServerApp({
	// The Cloudflare runtime adapter owns the per-request pg client over
	// Hyperdrive, `waitUntil`, and the Durable Object room registry. This edge
	// points it at its OWN two bindings: the `Cloudflare.Env` cast and the
	// binding names live here, where they are type-checked against this Worker's
	// generated bindings (ADR-0059). Per-room DO sharding stays the cloud's
	// binding of the room actor forever: hibernate-to-zero and
	// single-writer-per-room at multi-tenant scale. A Bun host builds its own
	// adapter inline.
	runtime: cloudflare({
		hyperdrive: (env) => (env as Cloudflare.Env).HYPERDRIVE,
		room: (env) => (env as Cloudflare.Env).ROOM,
	}),
	identity: {
		// The hosted cloud's public origin never changes per deploy, so it is
		// baked from the constants source of truth rather than duplicated into
		// wrangler.jsonc vars. Local dev injects
		// `API_PUBLIC_ORIGIN=http://localhost:8787` via scripts/dev.ts; production
		// falls through to PRODUCTION_API_URL. `API_PUBLIC_ORIGIN` is
		// deployment-owned config, not a binding `ServerBindings` names, so casting
		// to this deployment's own `Cloudflare.Env` is the honest edge (ADR-0059).
		resolveOrigin: (env) =>
			(env as Cloudflare.Env).API_PUBLIC_ORIGIN ?? PRODUCTION_API_URL,
		resolveTrustedOrigins: buildEpicenterTrustedOrigins,
		// Epicenter cloud serves app.epicenter.so and api.epicenter.so, which share
		// a session via a cookie scoped to the registrable domain. cookie-config
		// falls back to host-only on localhost regardless.
		cookieDomain: '.epicenter.so',
	},
});

// Public health endpoint at root.
app.get('/', (c) =>
	c.json({ mode: 'hub', version: '0.1.0', runtime: 'cloudflare' }),
);

// Auth surface (HTML pages + OAuth metadata; no /api prefix by design,
// no deployment knobs).
app.route('/', authApp);

// Owner-partitioned reusable surfaces. Each primitive owns its own
// auth + ownership wiring; the deployment passes only the rule and any
// deployment policies.
mountSessionApp(app, { ownership });
mountRoomsApp(app, { ownership });
// Content-addressed blob store (supersedes the retired assets surface). v1 is
// unmetered (no Autumn policy): Autumn's check() denies by default with no plan
// attached, so deferred quota means not calling it. A `syncBlobStorageWithAutumn`
// policy slots in here when storage is billed.
mountBlobsApp(app, { ownership });
mountInferenceApp(app, {
	auth: requireBearerUser,
	ownership,
	policies: [chargeOpenAiCreditsWithAutumn],
});

// Cloud-only billing data plane. Auth is bundled into the mount so the
// dashboard endpoints can't be mounted without it.
mountBillingApi(app, { auth: requireCookieOrBearerUser });

// Dashboard SPA: Workers Static Assets binding serves the SvelteKit
// build. Cloud-only because the `ASSETS` binding lives in this worker's
// wrangler config; self-hosted deployments ship their own UI surface.
app.on(
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
app.get('/billing', (c) => c.redirect('/dashboard'));

// The Worker exposes the Hono fetch handler (the full URL surface above).
// `app.fetch` is bound, so destructuring it is safe.
export default {
	fetch: app.fetch,
};
export { Room };
