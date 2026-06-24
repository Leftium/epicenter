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
	connectHyperdriveDb,
	createDurableObjectRooms,
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

// The hosted cloud's public origin never changes per deploy, so it is baked
// from the constants source of truth rather than duplicated into wrangler.jsonc
// vars. Local dev injects `API_PUBLIC_ORIGIN=http://localhost:8787` via
// scripts/dev.ts; production falls through to PRODUCTION_API_URL.
// The library types `env` as its portable `ServerBindings`; this Worker's
// resolvers read Cloudflare-only bindings (`HYPERDRIVE`, `ROOM`) and the
// deployment-owned `API_PUBLIC_ORIGIN`, none of which `ServerBindings` names.
// Casting to this deployment's own `Cloudflare.Env` is the honest edge where
// naming Cloudflare belongs (ADR-0059); the library never does.
const app = createServerApp({
	resolveOrigin: (env) =>
		(env as Cloudflare.Env).API_PUBLIC_ORIGIN ?? PRODUCTION_API_URL,
	resolveTrustedOrigins: buildEpicenterTrustedOrigins,
	// Epicenter cloud serves app.epicenter.so and api.epicenter.so, which share
	// a session via a cookie scoped to the registrable domain. cookie-config
	// falls back to host-only on localhost regardless.
	cookieDomain: '.epicenter.so',
	// Cloudflare runtime bindings, composed at this edge: a per-request pg
	// client over Hyperdrive, and `waitUntil` to keep the isolate alive while
	// the after-response queue drains.
	connectDb: (env) => connectHyperdriveDb((env as Cloudflare.Env).HYPERDRIVE),
	afterResponse: (c, work) => c.executionCtx.waitUntil(work),
	// Per-room Durable Object sharding stays the cloud's binding of the room
	// actor forever (ADR-0059): hibernate-to-zero and single-writer-per-room
	// at multi-tenant scale. A Bun host swaps in an in-process registry.
	resolveRooms: (env) => createDurableObjectRooms((env as Cloudflare.Env).ROOM),
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
