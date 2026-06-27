/**
 * `startBunServer` — the hosted (apps/api) Bun process bootstrap (ADR-0066).
 *
 * Everything mechanical for the hosted cloud on Bun (the `pg.Pool`, the
 * `bun:sqlite` room registry, the `bun()` adapter, `createServerApp`, the cloud
 * auth layer plus session + rooms + inference mounts, and `Bun.serve` +
 * `bindServer`) lives here once; `apps/api/server.ts` supplies only the
 * per-deployment composition (ownership, trusted origins, port, blobs, an optional
 * dev resolver).
 *
 * It is the hosted cloud's bootstrap, not a shared one: the single-partition
 * instance composes its Bun entry directly (`apps/self-host/server.ts`), because
 * it diverges on the substrate that matters here (no Better Auth, no sessions,
 * bearer-only, and after the pg-drop no Postgres at all, ADR-0073). Forcing both
 * products through one factory would re-introduce the mode knob the ADR deleted.
 *
 * This module is the Bun surface and is never in the Worker bundle: it imports
 * `pg`, `createBunRooms` (`bun:sqlite`), and `Bun.serve` directly. It is
 * reached through the `@epicenter/server/bun` barrel.
 *
 * Env validation stays in the entry, not here: the entry owns its own error label,
 * validates `process.env` against {@link BunHostBindings} (merging its extras,
 * e.g. the Google secrets it re-requires), and hands the validated value in. The
 * boot banner likewise stays in the entry (an app may log; library code may not),
 * which is why this returns the resolved `origin` and `dataDir` instead of logging
 * them.
 */

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Hono } from 'hono';
import pg from 'pg';
import { createDb } from './db/create-db.js';
import {
	requireBearerUser,
	requireCookieOrBearerUser,
	resolveRequestOAuthUser,
} from './middleware/require-auth.js';
import { mountCloudAuth } from './mount-cloud-auth.js';
import type { OwnershipRule } from './ownership.js';
import { createBunRooms } from './room/backends/bun/registry.js';
import { mountInferenceApp } from './routes/inference.js';
import { mountRoomsApp, recordRoomAccessOnDb } from './routes/rooms.js';
import { mountSessionApp } from './routes/session.js';
import { bun } from './runtime/bun.js';
import { createServerApp, type Identity } from './server-app.js';
import { ServerBindings } from './server-bindings.js';
import type { Env, ResolveUser } from './types.js';

/**
 * The hosted Bun-host env contract: the portable {@link ServerBindings} plus the
 * process-level config the hosted Bun entry reads. The entry validates
 * `process.env` against this (merging its own extras) and hands the validated
 * value to {@link startBunServer}. `DATABASE_URL` is the one required addition;
 * the rest default in `startBunServer`.
 */
export const BunHostBindings = ServerBindings.merge({
	DATABASE_URL: 'string',
	'PORT?': 'string',
	'API_PUBLIC_ORIGIN?': 'string',
	'DATA_DIR?': 'string',
});
export type BunHostBindings = typeof BunHostBindings.infer;

export type StartBunServerOptions = {
	/**
	 * The validated env. Assignable to {@link BunHostBindings}: the entry may carry
	 * extra fields (e.g. the re-required Google secrets) it read in its own scope.
	 */
	env: BunHostBindings;
	/** Port to listen on when `env.PORT` is unset (apps/api 8788). */
	defaultPort: number;
	/** The `mode` string the health endpoint returns at `/` (`hub`). */
	mode: string;
	/** This deployment's partition rule (apps/api passes `personal()`). */
	ownership: OwnershipRule;
	/** The origins this deployment trusts (CORS, cookie-CSRF, Better Auth redirects). */
	resolveTrustedOrigins: Identity['resolveTrustedOrigins'];
	/** Registrable cookie domain, when this deployment spans subdomains. */
	cookieDomain?: string;
	/**
	 * Extra sub-apps beyond the session/rooms/inference surface (apps/api adds
	 * `mountBlobsApp`).
	 */
	mountExtras?: (app: Hono<Env>, ownership: OwnershipRule) => void;
	/**
	 * Dev-only user resolver the dev entry injects to drive the parity smoke
	 * without an interactive login. Production omits it and keeps the real OAuth
	 * resolver.
	 */
	resolveUser?: ResolveUser;
};

/**
 * Boot the hosted cloud on Bun: build the runtime, compose the cloud auth layer
 * plus the session/rooms/inference surface and any extras, and listen. Returns
 * the resolved `origin` and room `dataDir` so the entry can log its own boot
 * banner.
 */
export function startBunServer({
	env,
	defaultPort,
	mode,
	ownership,
	resolveTrustedOrigins,
	cookieDomain,
	mountExtras,
	resolveUser,
}: StartBunServerOptions): { origin: string; dataDir: string } {
	const port = Number(env.PORT ?? defaultPort);
	// The auth origin must match where the process actually listens (cookies, the
	// OAuth issuer, the token audience all derive from it). Default to localhost
	// on the chosen port; an operator overrides it with their domain.
	const origin = env.API_PUBLIC_ORIGIN ?? `http://localhost:${port}`;

	// One room directory of `bun:sqlite` files for this host.
	const dataDir = resolve(env.DATA_DIR ?? './.data/rooms');
	mkdirSync(dataDir, { recursive: true });
	const bunRooms = createBunRooms({ dir: dataDir });

	// One pool for the process; drizzle checks a client out per query and returns
	// it, so `bun()`'s `connectDb` hands back the shared handle with a no-op close.
	const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
	const db = createDb(pool);

	const app = createServerApp({
		runtime: bun({ db, rooms: bunRooms.rooms }),
		identity: {
			resolveOrigin: () => origin,
			resolveTrustedOrigins,
		},
		// The dev entry passes a dev bearer resolver for the parity smoke; production
		// keeps the real OAuth bearer resolver.
		resolveUser: resolveUser ?? resolveRequestOAuthUser,
	});

	app.get('/', (c) => c.json({ mode, version: '0.1.0', runtime: 'bun' }));
	// The cloud's relational-auth layer (Better Auth on `c.var.auth` + the auth
	// surface), mounted before the owner-scoped surfaces read it.
	mountCloudAuth(app, { cookieDomain });
	mountSessionApp(app, { ownership, auth: requireCookieOrBearerUser });
	mountRoomsApp(app, { ownership, recordAccess: recordRoomAccessOnDb });
	mountInferenceApp(app, { auth: requireBearerUser, ownership });
	mountExtras?.(app, ownership);

	const server = Bun.serve({
		port,
		// Bun calls `fetch(req, server)`; route everything through the Hono app
		// with the validated env as `c.env`. WebSocket upgrades happen inside the
		// rooms route via the bound server (see createBunRooms), after auth runs,
		// so they are never intercepted ahead of the auth pipeline here.
		fetch: (req) => app.fetch(req, env),
		websocket: bunRooms.websocket,
	});
	// `server` only exists once `Bun.serve` returns; hand it to the room registry
	// so `handleUpgrade` can call `server.upgrade`.
	bunRooms.bindServer(server);

	return { origin, dataDir };
}
