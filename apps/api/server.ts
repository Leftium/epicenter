/**
 * Bun entry for apps/api: the runtime port's keystone second runtime.
 *
 * Builds the SAME `createServerApp(...)` the Cloudflare Worker builds
 * (`worker/index.ts`), but binds the per-concern runtime hooks to plain
 * primitives instead of Cloudflare bindings (ADR-0066):
 *
 *   - the `db` leg   a module-scope `pg.Pool` over `DATABASE_URL`, drained
 *                    fire-and-forget in the live process (no `waitUntil`)
 *   - `resolveRooms` an in-process registry over `bun:sqlite` files
 *   - blobs          any S3 endpoint via the existing `BLOBS_S3_*` env
 *
 * This is additive: `wrangler dev`/`deploy` still serve the Worker unchanged.
 * `bun --watch server.ts` boots instantly with real stack traces. It is the
 * hosted cloud on Bun (local dev and the runtime-parity smoke), NOT the self-host
 * artifact: the single-partition instance has its own entry
 * (`apps/self-host/server.ts`), composing no Better Auth and no Postgres (ADR-0075).
 *
 * The whole hosted-cloud-on-Bun bootstrap lives here, in the app, not behind a
 * shared `@epicenter/server` factory: everything mechanical (the `pg.Pool`, the
 * `bun:sqlite` rooms, the cloud auth layer, the session/rooms/inference/blobs
 * mounts, `Bun.serve`) is this app's composition to own. The instance does NOT
 * share it (it diverges on the substrate that matters: no Better Auth, no
 * Postgres), so a shared launcher would re-introduce the mode knob ADR-0075/0076
 * deleted. The library ships the parts; each Bun entry composes its own product.
 *
 * The wiring lives in {@link startBunApiServer} so `server.dev.ts` can boot the
 * SAME server with a dev `resolveUser` injected (the parity smoke's credential)
 * without duplicating it. The bottom of this file runs production only when this
 * file IS the entrypoint (`import.meta.main`), so `server.dev.ts` importing the
 * builder does not also start a second listener. Production passes no
 * `resolveUser` and keeps the real OAuth resolver; this file never imports the
 * dev bypass.
 *
 * Runtime skew is fenced by design: a DO-only behavior (hibernation restore,
 * alarm timing, edge placement) will not surface here, so `wrangler dev` /
 * staging stays the fidelity gate before any deploy touching room behavior.
 *
 * The dashboard SPA and billing data plane are intentionally omitted: Vite
 * serves the dashboard in dev, and billing is the hosted Worker's concern.
 */

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { API_BUN_DEV_PORT } from '@epicenter/constants/apps';
import {
	bun,
	CloudAuthBindings,
	createBunRooms,
	createDb,
	createServerApp,
	mountBlobsApp,
	mountCloudAuth,
	mountInferenceApp,
	mountRoomsApp,
	mountSessionApp,
	personal,
	type ResolveUser,
	requireBearerUser,
	requireCookieOrBearerUser,
	resolveRequestOAuthUser,
	ServerBindings,
} from '@epicenter/server/bun';
import { type } from 'arktype';
import pg from 'pg';
import { buildEpicenterTrustedOrigins } from './worker/trusted-origins.js';

/**
 * The apps/api Bun env contract: the portable {@link ServerBindings}, the
 * Cloud-only {@link CloudAuthBindings} (Better Auth + OAuth secrets, ADR-0076),
 * and this host's process config (`DATABASE_URL`, port, origin, data dir).
 *
 * `CloudAuthBindings` already requires `BETTER_AUTH_SECRET` and leaves each OAuth
 * provider optional (register-when-present, ADR-0071); this hub additionally
 * mandates Google (its one sign-in method) by re-declaring it required. So a
 * misconfiguration fails closed at boot instead of as a downstream surprise.
 * Unlike the Cloudflare edge (whose bindings are deploy-gated and
 * `wrangler types`-typed), `process.env` is unchecked, so boot is the place to
 * validate it. The validated env is also what feeds `mountCloudAuth`'s
 * `resolveAuthSecrets` below, so the Cloud-only secrets reach Better Auth without
 * ever entering the portable `ServerBindings`.
 */
const ApiBunBindings = ServerBindings.merge(CloudAuthBindings).merge({
	DATABASE_URL: 'string',
	'PORT?': 'string',
	'API_PUBLIC_ORIGIN?': 'string',
	'DATA_DIR?': 'string',
	GOOGLE_CLIENT_ID: 'string',
	GOOGLE_CLIENT_SECRET: 'string',
});

/**
 * Boot the apps/api Bun server, optionally with an injected user resolver.
 *
 * Production (`server.ts` as the entrypoint) passes nothing, so
 * `createServerApp` keeps the real OAuth resolver. `server.dev.ts` passes a
 * dev `Bearer dev:<userId>` resolver so the parity smoke needs no interactive
 * login. Everything else (env validation, pool, rooms, mounts, `Bun.serve`) is
 * identical across the two, so they cannot drift.
 */
export function startBunApiServer(
	opts: { resolveUser?: ResolveUser } = {},
): void {
	// Validate this Bun host's environment once, at boot. The validated result IS
	// the typed env handed to the Hono app: no `as`-cast over `process.env`, no
	// lie (ADR-0066). A misconfiguration gets ONE descriptive error naming every
	// missing or malformed var.
	const env = ApiBunBindings(process.env);
	if (env instanceof type.errors) {
		console.error(`Invalid environment for the Bun server:\n${env.summary}`);
		process.exit(1);
	}

	const port = Number(env.PORT ?? API_BUN_DEV_PORT);
	// The auth origin must match where the process actually listens (cookies, the
	// OAuth issuer, the token audience all derive from it). Default to localhost
	// on the chosen port; an operator overrides it with their domain.
	const origin = env.API_PUBLIC_ORIGIN ?? `http://localhost:${port}`;

	// One room directory of `bun:sqlite` files for this host.
	const dataDir = resolve(env.DATA_DIR ?? './.data/rooms');
	mkdirSync(dataDir, { recursive: true });
	const bunRooms = createBunRooms({ dir: dataDir });

	// One pool for the process; drizzle checks a client out per query and returns
	// it, so `bun()`'s `db.connect` hands back the shared handle with a no-op close.
	const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
	const db = createDb(pool);

	const ownership = personal();
	const app = createServerApp({
		runtime: bun({ db, rooms: bunRooms.rooms }),
		identity: {
			resolveOrigin: () => origin,
			resolveTrustedOrigins: buildEpicenterTrustedOrigins,
		},
	});

	// The dev entry passes a dev bearer resolver for the parity smoke; production
	// keeps the real OAuth bearer resolver. Each owner-scoped wrapper closes over it.
	const resolveUser = opts.resolveUser ?? resolveRequestOAuthUser;
	const cookieOrBearer = requireCookieOrBearerUser(resolveUser);
	const bearer = requireBearerUser(resolveUser);

	app.get('/', (c) =>
		c.json({ product: 'hub', version: '0.1.0', runtime: 'bun' }),
	);
	// The cloud's relational-auth layer (Better Auth on `c.var.auth` + the auth
	// surface), mounted before the owner-scoped surfaces read it. Host-only cookies
	// on the Bun dev host (no cross-subdomain domain like the Worker's `.epicenter.so`).
	// The Cloud-only auth secrets come from the validated `env` closure (ADR-0076),
	// never the portable `ServerBindings`.
	mountCloudAuth(app, { resolveAuthSecrets: () => env });
	mountSessionApp(app, { ownership, auth: cookieOrBearer });
	// Rooms resolves the bearer itself (WS-aware), so it takes the raw resolver.
	mountRoomsApp(app, { ownership, resolveUser });
	mountInferenceApp(app, { auth: bearer, ownership });
	mountBlobsApp(app, { ownership, auth: cookieOrBearer });

	const server = Bun.serve({
		port,
		// Bun calls `fetch(req, server)`; route everything through the Hono app with
		// the validated env as `c.env`. WebSocket upgrades happen inside the rooms
		// route via the bound server (see createBunRooms), after auth runs, so they
		// are never intercepted ahead of the auth pipeline here.
		fetch: (req) => app.fetch(req, env),
		websocket: bunRooms.websocket,
	});
	// `server` only exists once `Bun.serve` returns; hand it to the room registry
	// so `handleUpgrade` can call `server.upgrade`.
	bunRooms.bindServer(server);

	console.log(`apps/api (Bun) listening on ${origin} (rooms in ${dataDir})`);
}

// Run production only when this file is the entrypoint. `server.dev.ts` imports
// `startBunApiServer` to boot the dev variant, and must not trigger a second
// listener here.
if (import.meta.main) startBunApiServer();
