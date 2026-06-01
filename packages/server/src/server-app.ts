/**
 * Server app factory. Wires per-request lifecycle (pg connection,
 * after-response queue, auth instance, CORS, CSRF) and returns a `Hono`
 * instance the deployment mounts every other sub-app on.
 *
 * The deployment supplies its own canonical API origin through
 * {@link CreateServerAppOptions.resolveOrigin}: the hosted cloud bakes a
 * constant (`apps/api`), a self-host reads operator config (`apps/self-host`).
 * The library never reaches for a shared `c.env` var name, so the origin is
 * always explicit and never inferred from the request. This `resolveOrigin`
 * hook is the first slice of the future runtime port (db, sessionStore,
 * assets, rooms, afterResponse); see
 * `specs/20260528T130000-runtime-port-and-public-origin.md`.
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import { Hono } from 'hono';
import pg from 'pg';
import { createAuth } from './auth/create-auth.js';
import * as schema from './db/schema/index.js';
import { corsMiddleware } from './middleware/cors.js';
import { requireOriginForCookieMutations } from './middleware/require-origin-for-cookie-mutations.js';
import { createDurableObjectRooms } from './room/backends/cloudflare/registry.js';
import type { Env } from './types.js';

/**
 * Construct the parent `Hono` app every deployment mounts sub-apps onto.
 *
 * Installs three ordered request-scoped middlewares:
 *
 *   1. CORS (skips WS upgrades).
 *   2. Per-request pg connection + after-response queue.
 *   3. Better Auth context (baseURL, auth instance).
 *
 * Then mounts the global CSRF gate for cookie-auth mutations on `/api/*`
 * and the rooms registry. The deployment is responsible for exposing a
 * health endpoint on `/`. WebSocket auth-transport normalization is not
 * global: it lives in {@link mountRoomsApp}, the only WebSocket surface.
 */
type CreateServerAppOptions = {
	/**
	 * Resolve this deployment's canonical public origin from the per-request
	 * `c.env`. Becomes the Better Auth `baseURL`, OAuth issuer, and token
	 * audience, so it must be stable per deployment and never inferred from
	 * `c.req.url`. `apps/api` returns `env.API_PUBLIC_ORIGIN ?? PRODUCTION_API_URL`
	 * (dev override, else the baked constant); `apps/self-host` returns the
	 * operator-set `env.API_PUBLIC_ORIGIN`.
	 */
	resolveOrigin: (env: Cloudflare.Env) => string;
};

export function createServerApp({
	resolveOrigin,
}: CreateServerAppOptions): Hono<Env> {
	const app = new Hono<Env>();

	// 0. Deployment auth origin. Resolved first (a pure read of the env binding,
	// no DB) so downstream middleware, including CORS and the cookie-CSRF guard,
	// can scope the trusted-origin allow-list to this deployment. See note 3 for
	// why the origin is supplied explicitly and never inferred from the request.
	app.use('*', async (c, next) => {
		c.set('authBaseURL', resolveOrigin(c.env));
		await next();
	});

	// 1. CORS
	app.use('*', corsMiddleware);

	// 2. Per-request pg client + after-response promise list.
	// Uses Client (not Pool) because Hyperdrive IS the connection pool.
	// Handlers push fire-and-forget promises (typically DB writes) onto
	// `afterResponse`; the finally block waits for all of them to settle
	// before closing pg, so writes that outlive the response don't hit a
	// closed client.
	app.use('*', async (c, next) => {
		const client = new pg.Client({
			connectionString: c.env.HYPERDRIVE.connectionString,
		});
		const afterResponse: Promise<unknown>[] = [];
		try {
			await client.connect();
			c.set('db', drizzle(client, { schema }));
			c.set('afterResponse', afterResponse);
			await next();
		} finally {
			c.executionCtx.waitUntil(
				Promise.allSettled(afterResponse).then(() => client.end()),
			);
		}
	});

	// 3. Auth context. `resolveOrigin` yields the deployment's canonical auth
	// origin: the Better Auth baseURL, OAuth issuer, and token audience. It
	// must be stable per deployment (a self-host gets its own domain, not
	// Epicenter Cloud's), so the deployment supplies it explicitly, never
	// inferred from the request. Dev injects localhost via scripts/dev.ts.
	// First-party OAuth client rows are seeded at deploy time (apps/api
	// `oauth:seed:*`), so this path only reads.
	app.use('*', async (c, next) => {
		c.set(
			'auth',
			createAuth({
				db: c.var.db,
				env: c.env,
				baseURL: c.var.authBaseURL,
			}),
		);
		await next();
	});

	// CSRF gate on every `/api/*` route. Bearer requests are CSRF-immune
	// and skip this check inside the middleware.
	app.use('/api/*', requireOriginForCookieMutations);

	// Rooms registry: bound for any sub-app that reads `c.var.rooms`.
	// The Cloudflare backend wraps `env.ROOM`; a future Bun backend wires
	// its own in-process Rooms here instead.
	app.use('/api/*', async (c, next) => {
		c.set('rooms', createDurableObjectRooms(c.env.ROOM));
		await next();
	});

	return app;
}
