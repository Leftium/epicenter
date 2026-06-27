/**
 * `mountCloudAuth`: the cloud-only relational-auth layer (Better Auth + Postgres).
 *
 * The hosted cloud composes Better Auth: a per-request `c.var.auth` instance
 * (sessions, OAuth, JWKS) over Postgres, plus the `authApp` surface (sign-in,
 * consent, OAuth metadata, and the Better Auth catch-all). The single-partition
 * instance composes NEITHER (ADR-0073): it authenticates one operator-supplied
 * bearer and has no sessions, so it never calls this and never constructs Better
 * Auth. That is the seam that lets an instance drop Postgres entirely.
 *
 * Call it once, right after `createServerApp` and before the owner-scoped mounts:
 * it installs the auth-context middleware (so `c.var.auth` is set before any
 * cookie-or-bearer wrapper or `authApp` route reads it) and mounts `authApp` at
 * the root.
 */

import type { Hono } from 'hono';
import { createAuth } from './auth/create-auth.js';
import { authApp } from './routes/auth.js';
import type { Env } from './types.js';

export function mountCloudAuth(
	app: Hono<Env>,
	opts: {
		/**
		 * Registrable domain for cross-subdomain session cookies (Epicenter cloud
		 * passes `.epicenter.so`). Omit for a single-origin deployment, which then
		 * uses host-only cookies scoped to its own host.
		 */
		cookieDomain?: string;
	} = {},
): void {
	// Better Auth context. Built per request (Workers expose no module-scope env
	// or db connection), reading the db handle, auth origin, and trusted origins
	// the `createServerApp` lifecycle already resolved. Installed before the
	// cookie-or-bearer wrappers and the `authApp` routes mounted below read
	// `c.var.auth`. First-party OAuth client rows are seeded at deploy time
	// (apps/api `oauth:seed:*`), so this path only reads.
	app.use('*', async (c, next) => {
		c.set(
			'auth',
			createAuth({
				db: c.var.db,
				env: c.env,
				baseURL: c.var.authBaseURL,
				trustedOrigins: c.var.trustedOrigins,
				cookieCrossSubDomain: opts.cookieDomain,
			}),
		);
		await next();
	});
	// Auth surface (HTML pages + OAuth metadata; no /api prefix by design).
	app.route('/', authApp);
}
