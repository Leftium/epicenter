/**
 * Server app factory. Wires per-request lifecycle (pg connection,
 * after-response queue, auth instance, CORS, CSRF) and returns a `Hono`
 * instance the deployment mounts every other sub-app on.
 *
 * It takes exactly two things, the two axes a deployment varies on:
 *
 *   - a {@link RuntimeAdapter}: how THIS runtime does the three non-portable
 *     jobs (acquire a db connection, keep work alive past the response, bind
 *     the room registry). These are co-selected by which runtime you are on, so
 *     they travel together as one value built at the edge: `cloudflare()` on
 *     Workers, an inline literal on Bun. Never restated as loose hooks per edge.
 *   - an {@link Identity}: who THIS deployment is on the web (its canonical
 *     origin, the origins it trusts, its cookie scope). These vary per
 *     deployment, NOT per runtime: `apps/api` passes the same identity whether
 *     it runs on Workers or Bun.
 *
 * Per-concern injection at the deployment edge, refining ADR-0059. The ADR
 * rejected a single `Runtime` god-object, but that object carried PORTABLE
 * concerns (db driver, session store, assets) as co-equal legs and overstated
 * the port fivefold; those collapsed to open standards (Road 1). What survives
 * is the genuinely co-selected runtime triple, grouped here as a
 * `RuntimeAdapter`, plus a separate identity axis. The portable concerns (db
 * driver, blob store, auth) stay library code reading `ServerBindings`, never
 * injected at all. The library never reaches for a shared `c.env` var name, so
 * the auth origin is always explicit and never inferred from the request.
 */

import { type Context, Hono } from 'hono';
import { createAuth } from './auth/create-auth.js';
import type { Db } from './db/create-db.js';
import { corsMiddleware } from './middleware/cors.js';
import { resolveRequestOAuthUser } from './middleware/require-auth.js';
import { requireOriginForCookieMutations } from './middleware/require-origin-for-cookie-mutations.js';
import type { Rooms } from './room/contracts.js';
import type { ServerBindings } from './server-bindings.js';
import type { Env, ResolveUser } from './types.js';

/**
 * How one runtime does the three non-portable jobs, as one value (ADR-0059,
 * refined). A deployment never mixes these legs: a per-request `pg.Client` over
 * Hyperdrive, `waitUntil`, and a Durable Object are ALL the Cloudflare runtime;
 * a `pg.Pool` checkout, a no-op, and an in-process registry are ALL the Bun
 * runtime. They are co-selected by which runtime you are on, so they travel
 * together as a `RuntimeAdapter` the deployment builds once (`cloudflare()` on
 * Workers, an inline literal on Bun) instead of three loose hooks restated per
 * edge.
 *
 * This is NOT the `Runtime` god-object ADR-0059 rejected: that one carried
 * portable concerns (db driver, session store, assets) as co-equal legs. Those
 * collapsed to open standards (Road 1). What remains here is exactly the set
 * that needs a runtime-specific handle (`HYPERDRIVE`, `ROOM`) or primitive
 * (`waitUntil`); the blob store and auth, being portable, are library code
 * reading {@link ServerBindings}, never members.
 *
 * Each leg receives `env` typed as the library's portable `ServerBindings`, so
 * the library names no `Cloudflare.Env` and a Bun host typechecks with no
 * Cloudflare types in scope. The Cloudflare adapter takes binding extractors
 * from the app edge, where the `Cloudflare.Env` cast is honest and type-checked
 * against the deployment's generated bindings, and never names a binding
 * itself; the Bun adapter reads nothing Cloudflare-shaped (it closes over
 * module-scope primitives).
 */
export type RuntimeAdapter = {
	/**
	 * Acquire a per-request database handle, and how to close it. Only
	 * acquisition is injected: the library depends on the portable `pg`/drizzle
	 * Postgres wire (ADR-0059 Road 1), never a binding shape. Cloudflare passes a
	 * per-request `pg.Client` over Hyperdrive; a Bun host hands back a module-scope
	 * `pg.Pool` checkout. The returned `close` runs after the after-response queue
	 * drains.
	 */
	connectDb: (env: ServerBindings) => Promise<{
		db: Db;
		close: () => Promise<void>;
	}>;
	/**
	 * Keep fire-and-forget work alive past the HTTP response. On Cloudflare this
	 * is `c.executionCtx.waitUntil(work)` (holds the isolate open); a Bun host
	 * lets the promise run in the live process and does nothing. The library owns
	 * the after-response queue (`c.var.afterResponseQueue`) and the pg-drain
	 * shape; this injects only how the drain is kept alive.
	 */
	afterResponse: (c: Context<Env>, work: Promise<unknown>) => void;
	/**
	 * Resolve this deployment's room registry, the one subsystem with no open
	 * standard (a hibernating single-writer actor, ADR-0059 Road 2): Cloudflare
	 * wraps `env.ROOM` (`createDurableObjectRooms`); a Bun host returns an
	 * in-process registry (`createBunRooms`). Bound per request onto `c.var.rooms`.
	 */
	resolveRooms: (env: ServerBindings) => Rooms;
};

/**
 * Who this deployment IS on the web. Orthogonal to {@link RuntimeAdapter}:
 * these vary per deployment, not per runtime, so they are supplied explicitly
 * and the auth origin is never inferred from the request.
 */
export type Identity = {
	/**
	 * This deployment's canonical public origin, resolved from the per-request
	 * `env`. Becomes the Better Auth `baseURL`, OAuth issuer, and token audience,
	 * so it must be stable per deployment and never inferred from `c.req.url`.
	 * `apps/api` returns `env.API_PUBLIC_ORIGIN ?? PRODUCTION_API_URL` (dev
	 * override, else the baked constant); `apps/self-host` returns the operator-set
	 * `env.API_PUBLIC_ORIGIN`.
	 */
	resolveOrigin: (env: ServerBindings) => string;
	/**
	 * The origins this deployment trusts for CORS, cookie-mutation CSRF, and
	 * Better Auth's redirect allow-list. The library hardcodes none: `apps/api`
	 * supplies the Epicenter app origins, a self-host supplies its own. Receives
	 * the resolved `baseURL` so a deployment can include its own origin without
	 * restating it.
	 */
	resolveTrustedOrigins: (baseURL: string) => string[];
	/**
	 * Registrable domain for cross-subdomain session cookies, when the
	 * deployment shares sessions across subdomains (Epicenter cloud passes
	 * `.epicenter.so`). Omit for a single-origin deployment, which then uses
	 * host-only cookies scoped to its own host.
	 */
	cookieDomain?: string;
};

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
	/** How this runtime does the three non-portable jobs. {@link RuntimeAdapter}. */
	runtime: RuntimeAdapter;
	/** Who this deployment is on the web. {@link Identity}. */
	identity: Identity;
	/**
	 * How a request resolves to the calling user, injected once for the whole
	 * deployment and stamped onto `c.var.resolveUser`. Defaults to the real
	 * resolver ({@link resolveRequestOAuthUser}: an OAuth bearer verified against
	 * JWKS); the surface wrappers read it from the context, so injecting here
	 * redirects all of them at once and leaves their cookie / WS-reject / 401
	 * behavior untouched. Production passes nothing and keeps the real resolver.
	 *
	 * A dev-only entrypoint injects a trivial `Bearer dev:<userId>` resolver so
	 * the runtime-parity smoke needs no interactive login. That bypass must live
	 * in a dev entry production never imports, NEVER an env-gated branch in this
	 * library. See {@link ResolveUser}.
	 */
	resolveUser?: ResolveUser;
};

export function createServerApp({
	runtime: { connectDb, afterResponse, resolveRooms },
	identity: { resolveOrigin, resolveTrustedOrigins, cookieDomain },
	resolveUser = resolveRequestOAuthUser,
}: CreateServerAppOptions): Hono<Env> {
	const app = new Hono<Env>();

	// 0. Deployment auth origin and trust set. Resolved first (a pure read of
	// the env binding, no DB) so downstream middleware, including CORS and the
	// cookie-CSRF guard, can scope the trusted-origin allow-list to this
	// deployment. See note 3 for why the origin is supplied explicitly and never
	// inferred from the request.
	app.use('*', async (c, next) => {
		const baseURL = resolveOrigin(c.env);
		c.set('authBaseURL', baseURL);
		c.set('trustedOrigins', resolveTrustedOrigins(baseURL));
		await next();
	});

	// 1. CORS
	app.use('*', corsMiddleware);

	// 2. Per-request db handle + after-response promise list.
	// `connectDb` is the injected runtime concern: it acquires the handle and
	// returns how to close it (a per-request `pg.Client` on Cloudflare, a
	// shared `pg.Pool` checkout on Node). Handlers push fire-and-forget
	// promises (typically DB writes) onto the queue; the finally block schedules
	// a drain (await all queued work, then close) via the injected
	// `afterResponse`, so writes that outlive the response don't hit a closed
	// handle and the response is never blocked on them.
	app.use('*', async (c, next) => {
		const { db, close } = await connectDb(c.env);
		const queue: Promise<unknown>[] = [];
		try {
			c.set('db', db);
			c.set('afterResponseQueue', queue);
			await next();
		} finally {
			afterResponse(
				c,
				Promise.allSettled(queue).then(() => close()),
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
				trustedOrigins: c.var.trustedOrigins,
				cookieCrossSubDomain: cookieDomain,
			}),
		);
		// The deployment's user-resolution seam. Bound here, beside the auth
		// instance the default resolver reads, so every downstream wrapper reads
		// one resolver off the context instead of hardcoding it. Production keeps
		// the real OAuth resolver; a dev entry injects a bearer resolver.
		c.set('resolveUser', resolveUser);
		await next();
	});

	// CSRF gate on every `/api/*` route. Bearer requests are CSRF-immune
	// and skip this check inside the middleware.
	app.use('/api/*', requireOriginForCookieMutations);

	// Rooms registry: bound for any sub-app that reads `c.var.rooms`.
	// `resolveRooms` is the injected runtime concern: the Cloudflare backend
	// wraps `env.ROOM`, a Node host returns its in-process registry.
	app.use('/api/*', async (c, next) => {
		c.set('rooms', resolveRooms(c.env));
		await next();
	});

	return app;
}
