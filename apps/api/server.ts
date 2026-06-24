/**
 * Bun entry for apps/api — the runtime port's keystone second runtime.
 *
 * Builds the SAME `createServerApp(...)` the Cloudflare Worker builds
 * (`worker/index.ts`), but binds the per-concern runtime hooks to plain
 * primitives instead of Cloudflare bindings (ADR-0057):
 *
 *   - `connectDb`     a module-scope `pg.Pool` over `DATABASE_URL`
 *   - `afterResponse` fire-and-forget in the live process (no `waitUntil`)
 *   - `resolveRooms`  an in-process registry over `bun:sqlite` files
 *   - blobs           any S3 endpoint via the existing `BLOBS_S3_*` env
 *
 * This is additive: `wrangler dev`/`deploy` still serve the Worker unchanged.
 * `bun --watch server.ts` boots instantly with real stack traces, and the same
 * entry is the "one binary + Postgres + S3, no Cloudflare account" self-host
 * artifact (and what a Tauri shell embeds locally).
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
import {
	authApp,
	createDb,
	createNodeRooms,
	createServerApp,
	mountBlobsApp,
	mountInferenceApp,
	mountRoomsApp,
	mountSessionApp,
	personal,
	requireBearerUser,
} from '@epicenter/server/node';
import pg from 'pg';
import { buildEpicenterTrustedOrigins } from './worker/trusted-origins.js';

// Fail fast on the two secrets with no safe default, with a runnable hint.
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
	console.error(
		'DATABASE_URL is required. Set a Postgres connection string (see .env.example).',
	);
	process.exit(1);
}
if (!process.env.BETTER_AUTH_SECRET) {
	console.error('BETTER_AUTH_SECRET is required (see .env.example).');
	process.exit(1);
}

const port = Number(process.env.PORT ?? 8788);
// The auth origin must match where the process actually listens (cookies, the
// OAuth issuer, the token audience all derive from it). Default to localhost on
// the chosen port; an operator overrides it with their domain.
const origin = process.env.API_PUBLIC_ORIGIN ?? `http://localhost:${port}`;

// One room directory of `bun:sqlite` files for this host.
const dataDir = resolve(process.env.DATA_DIR ?? './.data/rooms');
mkdirSync(dataDir, { recursive: true });
const nodeRooms = createNodeRooms({ dir: dataDir });

// One pool for the process; drizzle checks a client out per query and returns
// it, so `connectDb` hands back the shared handle with a no-op close.
const pool = new pg.Pool({ connectionString: DATABASE_URL });
const db = createDb(pool);

// `c.env` on this runtime is `process.env`: every secret the library reads
// (auth, blobs, inference house keys) is a portable string there, so the cast
// is the one honest edge between Bun's env and the Worker's binding type.
const env = process.env as unknown as Cloudflare.Env;

const ownership = personal();

const app = createServerApp({
	resolveOrigin: () => origin,
	resolveTrustedOrigins: buildEpicenterTrustedOrigins,
	connectDb: async () => ({ db, close: async () => {} }),
	afterResponse: (_c, work) => {
		void work;
	},
	resolveRooms: () => nodeRooms.rooms,
});

app.get('/', (c) => c.json({ mode: 'hub', version: '0.1.0', runtime: 'bun' }));
app.route('/', authApp);
mountSessionApp(app, { ownership });
mountRoomsApp(app, { ownership });
mountBlobsApp(app, { ownership });
mountInferenceApp(app, { auth: requireBearerUser, ownership });

const server = Bun.serve({
	port,
	// Bun calls `fetch(req, server)`; we route everything through the Hono app
	// with `process.env` as `c.env`. WebSocket upgrades are performed inside the
	// rooms route via the bound server (see createNodeRooms), after auth runs,
	// so they are never intercepted ahead of the auth pipeline here.
	fetch: (req) => app.fetch(req, env),
	websocket: nodeRooms.websocket,
});
// `server` only exists once `Bun.serve` returns; hand it to the room registry
// so `handleUpgrade` can call `server.upgrade`.
nodeRooms.bindServer(server);

console.log(`apps/api (Bun) listening on ${origin} — rooms in ${dataDir}`);
