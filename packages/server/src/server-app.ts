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
 * Per-concern injection at the deployment edge, refining ADR-0066. The ADR
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
import type { Db } from './db/create-db.js';
import { corsMiddleware } from './middleware/cors.js';
import { requireOriginForCookieMutations } from './middleware/require-origin-for-cookie-mutations.js';
import type { Rooms } from './room/contracts.js';
import type { ServerBindings } from './server-bindings.js';
import type { Env } from './types.js';

/**
 * How one runtime does the three non-portable jobs, as one value (ADR-0066,
 * refined). A deployment never mixes these legs: a per-request `pg.Client` over
 * Hyperdrive, `waitUntil`, and a Durable Object are ALL the Cloudflare runtime;
 * a `pg.Pool` checkout, a no-op, and an in-process registry are ALL the Bun
 * runtime. They are co-selected by which runtime you are on, so they travel
 * together as a `RuntimeAdapter` the deployment builds once (`cloudflare()` on
 * Workers, an inline literal on Bun) instead of three loose hooks restated per
 * edge.
 *
 * This is NOT the `Runtime` god-object ADR-0066 rejected: that one carried
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
	 * The Postgres lifecycle, as ONE optional leg whose two halves are
	 * inseparable. PRESENT only when the deployment composes Postgres (the hosted
	 * cloud: Better Auth + room telemetry); OMITTED entirely by the
	 * single-partition instance, which composes no Postgres, so `createServerApp`
	 * installs no db lifecycle middleware at all and `c.var.db` is never set
	 * (ADR-0075).
	 *
	 * The two halves are bundled rather than offered as independent optional
	 * siblings because either alone is a bug: a `connect` with no `afterResponse`
	 * would acquire a handle the drain never closes. Bundling makes "db, or no db"
	 * the only representable choice.
	 *
	 *   - `connect`       acquire a per-request database handle and how to close
	 *                     it. Only acquisition is injected: the library depends on
	 *                     the portable `pg`/drizzle Postgres wire (ADR-0066 Road
	 *                     1), never a binding shape. Cloudflare passes a per-request
	 *                     `pg.Client` over Hyperdrive; a Bun host hands back a
	 *                     module-scope `pg.Pool` checkout. The returned `close` runs
	 *                     after the after-response queue drains.
	 *   - `afterResponse` keep fire-and-forget work alive past the HTTP response.
	 *                     On Cloudflare this is `c.executionCtx.waitUntil(work)`
	 *                     (holds the isolate open); a Bun host lets the promise run
	 *                     in the live process and does nothing. The library owns the
	 *                     after-response queue (`c.var.afterResponseQueue`) and the
	 *                     pg-drain shape; this injects only how the drain is kept
	 *                     alive.
	 */
	db?: {
		connect: (env: ServerBindings) => Promise<{
			db: Db;
			close: () => Promise<void>;
		}>;
		afterResponse: (c: Context<Env>, work: Promise<unknown>) => void;
	};
	/**
	 * Resolve this deployment's room registry, the one subsystem with no open
	 * standard (a hibernating single-writer actor, ADR-0066 Road 2): Cloudflare
	 * wraps `env.ROOM` (`createDurableObjectRooms`); a Bun host returns an
	 * in-process registry (`createBunRooms`). Bound per request onto `c.var.rooms`.
	 * The one leg every deployment provides, including the Postgres-free instance.
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
};

/**
 * Construct the parent `Hono` app every deployment mounts sub-apps onto.
 *
 * Installs the ordered request-scoped middlewares:
 *
 *   1. CORS (skips WS upgrades).
 *   2. Per-request pg connection + after-response queue, ONLY when the runtime
 *      provides a `db` leg (the cloud does; the Postgres-free instance omits
 *      it, so `c.var.db` is never set, ADR-0075).
 *
 * Then mounts the global CSRF gate for cookie-auth mutations on `/api/*`
 * and the rooms registry. The deployment is responsible for exposing a
 * health endpoint on `/`. The Better Auth context (`c.var.auth`) is NOT
 * global: the cloud adds it via {@link mountCloudAuth} (Postgres-backed
 * sessions + OAuth), so the single-partition instance composes no Better Auth
 * (ADR-0075). WebSocket auth-transport normalization is likewise not global: it
 * lives in {@link mountRoomsApp}, the only WebSocket surface.
 */
type CreateServerAppOptions = {
	/** How this runtime does the three non-portable jobs. {@link RuntimeAdapter}. */
	runtime: RuntimeAdapter;
	/** Who this deployment is on the web. {@link Identity}. */
	identity: Identity;
};

export function createServerApp({
	runtime: { db, resolveRooms },
	identity: { resolveOrigin, resolveTrustedOrigins },
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

	// 2. Per-request db handle + after-response promise list, installed ONLY when
	// the runtime composes Postgres. `db.connect` acquires the handle and returns
	// how to close it (a per-request `pg.Client` on Cloudflare, a shared `pg.Pool`
	// checkout on a Bun host); handlers push fire-and-forget promises (typically DB
	// writes) onto the queue, and the finally block schedules a drain (await all
	// queued work, then close) via the runtime's `db.afterResponse`, so writes that
	// outlive the response don't hit a closed handle and the response is never
	// blocked on them. The single-partition instance provides no `db` leg
	// (it composes no Better Auth and records no telemetry), so this middleware is
	// never installed and the instance touches no Postgres (ADR-0075).
	if (db) {
		app.use('*', async (c, next) => {
			const { db: handle, close } = await db.connect(c.env);
			const queue: Promise<unknown>[] = [];
			try {
				c.set('db', handle);
				c.set('afterResponseQueue', queue);
				await next();
			} finally {
				db.afterResponse(
					c,
					Promise.allSettled(queue).then(() => close()),
				);
			}
		});
	}


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
