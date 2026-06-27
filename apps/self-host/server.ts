/**
 * Bun entry for apps/self-host: the single-partition instance (ADR-0073).
 *
 * The off-Cloudflare twin of `worker/index.ts`. It composes `@epicenter/server`
 * directly (it does NOT go through the hosted `startBunServer` bootstrap, which
 * bakes Better Auth and cookie sessions): the instance is a different product,
 * bearer-only with no relational-auth substrate, so it wires its own thin
 * composition. The per-concern runtime hooks bind to plain primitives instead of
 * Cloudflare bindings (ADR-0066):
 *
 *   - `afterResponse` fire-and-forget in the live process (no `waitUntil`)
 *   - `resolveRooms`  an in-process registry over `bun:sqlite` files
 *
 * This is the "one binary, no Cloudflare account" instance artifact: `bun
 * server.ts` (or a `bun build --compile` binary) is a complete box on a single
 * node. Rooms are `bun:sqlite` files on local disk, so this is a single-node
 * deployment by design: it does not shard or hibernate per room the way the
 * Durable Object edge does, which is exactly right for one homelab, one family, or
 * one small team and the price of owning your own data on your own machine.
 *
 * There is ONE shape, not a mode (ADR-0073). Ownership is `instance()`: every
 * request resolves to the pinned `owners/instance` partition, independent of who
 * presents the bearer. Authentication is one operator-supplied static bearer
 * (`INSTANCE_TOKEN`), constant-time compared. "Solo" and "shared" are not
 * configurations: they are only how many people you hand the one token to. No
 * OAuth, no sessions, no allowlist, no mode, no first-boot minting. Multi-tenant
 * per-user partitions are Epicenter Cloud's, never an instance's.
 *
 * Boot FAILS CLOSED if `INSTANCE_TOKEN` is missing or fails the entropy gate, with
 * an error that points at `gen-token`: the operator generates the token once
 * (`bun run gen-token`) and supplies it through the environment, never a file the
 * box mints. That gate replaces the 256-bit floor minting used to guarantee while
 * keeping the instance Bun-or-Cloudflare (the operator supplies the secret either
 * way).
 *
 * Surface: session + rooms + inference behind one bearer, zero billing, no
 * dashboard SPA, no auth surface. Blobs are intentionally not mounted; add
 * `mountBlobsApp` with `BLOBS_S3_*` set to offer a content-addressed media store
 * against any S3.
 */

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertStrongToken } from '@epicenter/auth';
import {
	BunHostBindings,
	bun,
	createBunRooms,
	createDb,
	createInstanceTokenResolver,
	createServerApp,
	instance,
	mountInferenceApp,
	mountRoomsApp,
	mountSessionApp,
	requireBearerUser,
	verifyEnvToken,
} from '@epicenter/server/bun';
import { type } from 'arktype';
import pg from 'pg';

/**
 * Resolve the operator-supplied `INSTANCE_TOKEN` or fail closed, naming the
 * generator. The library gate ({@link assertStrongToken}) owns the portable
 * length/charset rule; this wrapper owns the exit and names the concrete command,
 * so the operator is never left guessing how to mint a strong token.
 * `process.exit` returns `never`, so a successful call returns the strong token.
 */
function requireStrongInstanceToken(value: string | undefined): string {
	try {
		return assertStrongToken(value);
	} catch (e) {
		console.error(
			`Invalid configuration for the self-host instance:\n  ${(e as Error).message}\n` +
				'  Generate a strong token with: bun run gen-token',
		);
		process.exit(1);
	}
}

/** Boot the apps/self-host instance: validate env, build the bearer gate, listen. */
export function startSelfHostServer(): void {
	// Validate this host's environment once, at boot (ADR-0066): the portable
	// secrets (`BunHostBindings`) plus this host's own `INSTANCE_TOKEN`. A
	// misconfiguration gets ONE descriptive error naming every missing or malformed
	// var. The validated result IS the typed env handed to the Hono app: no
	// `as`-cast over `process.env`, no lie. `INSTANCE_TOKEN` is optional in the
	// schema (so the arktype pass never duplicates the entropy gate's message) and
	// asserted strong below.
	const env = BunHostBindings.merge({
		'INSTANCE_TOKEN?': 'string',
	})(process.env);
	if (env instanceof type.errors) {
		console.error(
			`Invalid environment for the self-host instance:\n${env.summary}`,
		);
		process.exit(1);
	}

	// The bearer gate. A strong `INSTANCE_TOKEN` builds the verifier-shaped
	// resolver (constant-time compare -> the named instance principal); a missing
	// or weak token fails boot above. The resolver is the deployment's injected
	// `ResolveUser`, feeding the one total gate exactly like the cloud's OAuth
	// resolver (ADR-0073).
	const token = requireStrongInstanceToken(env.INSTANCE_TOKEN);
	const resolveUser = createInstanceTokenResolver(verifyEnvToken(token));

	const port = Number(env.PORT ?? 8787);
	// The auth origin must match where the process actually listens. Default to
	// localhost; an operator overrides it with their own domain.
	const origin = env.API_PUBLIC_ORIGIN ?? `http://localhost:${port}`;

	// One room directory of `bun:sqlite` files for this host.
	const dataDir = resolve(env.DATA_DIR ?? './.data/rooms');
	mkdirSync(dataDir, { recursive: true });
	const bunRooms = createBunRooms({ dir: dataDir });

	// One pool for the process. The instance composes no Better Auth and records
	// no telemetry, so the db lifecycle connects this but no instance route reads
	// it; the pg-drop removes it entirely.
	const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
	const db = createDb(pool);

	const ownership = instance();
	const app = createServerApp({
		runtime: bun({ db, rooms: bunRooms.rooms }),
		identity: {
			resolveOrigin: () => origin,
			// A self-host trusts its OWN origin and the Tauri desktop client, never
			// Epicenter cloud's.
			resolveTrustedOrigins: (baseURL) => [
				new URL(baseURL).origin,
				'tauri://localhost',
			],
		},
		resolveUser,
	});

	app.get('/', (c) =>
		c.json({ mode: 'instance', version: '0.1.0', runtime: 'bun' }),
	);
	// No `mountCloudAuth`: the instance composes no Better Auth and no sessions. The
	// operator bearer (the `resolveUser` above) is the only gate, so every surface
	// is bearer-authenticated (ADR-0073).
	mountSessionApp(app, { ownership, auth: requireBearerUser });
	mountRoomsApp(app, { ownership });
	mountInferenceApp(app, { auth: requireBearerUser, ownership });

	const server = Bun.serve({
		port,
		fetch: (req) => app.fetch(req, env),
		websocket: bunRooms.websocket,
	});
	// `server` only exists once `Bun.serve` returns; hand it to the room registry
	// so `handleUpgrade` can call `server.upgrade`.
	bunRooms.bindServer(server);

	console.log(
		`apps/self-host instance (Bun) listening on ${origin} ` +
			`(rooms in ${dataDir}, partition owners/instance). Hand INSTANCE_TOKEN to ` +
			'whoever should have access.',
	);
}

// Run only when this file is the entrypoint.
if (import.meta.main) startSelfHostServer();
