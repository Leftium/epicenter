/**
 * Bun entry for apps/self-host: the single-partition instance (ADR-0074).
 *
 * The off-Cloudflare twin of `worker/index.ts`, and the instance's peer to the
 * hosted cloud's own Bun bootstrap (`apps/api/server.ts`). Each Bun entry owns
 * its composition rather than sharing a launcher: this one is bearer-only with no
 * relational-auth substrate (no Better Auth, no cookie sessions), so a shared
 * factory would re-introduce the mode knob ADR-0074/0075 deleted. It composes no
 * Postgres (no Better Auth, no telemetry), so its
 * runtime adapter (ADR-0066) provides only one leg:
 *
 *   - `resolveRooms`  an in-process registry over `bun:sqlite` files
 *
 * This is the "one binary, no Cloudflare account, no database" instance artifact:
 * `bun server.ts` (or a `bun build --compile` binary) is a complete box on a
 * single node. Rooms are `bun:sqlite` files on local disk, so this is a single-node
 * deployment by design: it does not shard or hibernate per room the way the
 * Durable Object edge does, which is exactly right for one homelab, one family, or
 * one small team and the price of owning your own data on your own machine.
 *
 * There is ONE shape, not a mode (ADR-0074). Ownership is `instance()`: every
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
	bun,
	createBunRooms,
	createInstanceTokenResolver,
	createServerApp,
	instance,
	mountInferenceApp,
	mountRoomsApp,
	mountSessionApp,
	rateLimit,
	requireBearerUser,
	ServerBindings,
	verifyEnvToken,
} from '@epicenter/server/bun';
import { type } from 'arktype';

/**
 * The instance's Bun env contract: the portable {@link ServerBindings} (the
 * cloud-only secrets stay optional and unused here) plus this host's process
 * config and its one bearer. There is deliberately NO `DATABASE_URL` and no
 * `BETTER_AUTH_SECRET`: the instance composes no Postgres and no Better Auth
 * (ADR-0074). `INSTANCE_TOKEN` is optional in the schema (so the arktype pass
 * never duplicates the entropy gate's message) and asserted strong below.
 */
const InstanceBindings = ServerBindings.merge({
	'PORT?': 'string',
	'API_PUBLIC_ORIGIN?': 'string',
	'DATA_DIR?': 'string',
	'INSTANCE_TOKEN?': 'string',
});

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
	// Validate this host's environment once, at boot (ADR-0066) against
	// {@link InstanceBindings}. A misconfiguration gets ONE descriptive error
	// naming every missing or malformed var. The validated result IS the typed env
	// handed to the Hono app: no `as`-cast over `process.env`, no lie.
	const env = InstanceBindings(process.env);
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
	// resolver (ADR-0074).
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

	const ownership = instance();
	const app = createServerApp({
		// No db leg: the instance composes no Postgres, so `createServerApp`
		// installs no db lifecycle and `c.var.db` is never set (ADR-0074).
		runtime: bun({ rooms: bunRooms.rooms }),
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
		c.json({ product: 'instance', version: '0.1.0', runtime: 'bun' }),
	);
	// No `mountCloudAuth`: the instance composes no Better Auth and no sessions. The
	// operator bearer (the `resolveUser` above) is the only gate, so every surface
	// is bearer-authenticated (ADR-0074).
	mountSessionApp(app, { ownership, auth: requireBearerUser });
	mountRoomsApp(app, { ownership });
	// Inference spends the operator's house key on every request. Cap the burn
	// rate so a leaked or overused bearer cannot run the provider bill up
	// unbounded between invoices. This is the in-process backstop; the real
	// ceiling is the hard spend limit you set on the provider key itself (README).
	// Tune to your group's size, or drop the policy to leave it uncapped.
	mountInferenceApp(app, {
		auth: requireBearerUser,
		ownership,
		policies: [rateLimit({ requests: 120, windowSeconds: 60 })],
	});

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
