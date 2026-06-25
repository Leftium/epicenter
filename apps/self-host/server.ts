/**
 * Bun entry for apps/self-host: the shared-wiki deployable, off Cloudflare.
 *
 * The off-Cloudflare twin of `worker/index.ts`. It builds the SAME
 * `createServerApp(...)` the Worker builds, but binds the per-concern runtime
 * hooks to plain primitives instead of Cloudflare bindings (ADR-0059):
 *
 *   - `connectDb`     a module-scope `pg.Pool` over `DATABASE_URL`
 *   - `afterResponse` fire-and-forget in the live process (no `waitUntil`)
 *   - `resolveRooms`  an in-process registry over `bun:sqlite` files
 *
 * This is the "one binary + Postgres, no Cloudflare account" self-host artifact:
 * `bun server.ts` (or a `bun build --compile` binary) is a complete shared wiki
 * on a single box. Rooms are `bun:sqlite` files on local disk, so this is a
 * single-node deployment by design: it does not shard or hibernate per room the
 * way the Durable Object edge does, which is exactly right for one community's
 * wiki and the price of owning your own data on your own machine.
 *
 * Ownership is `shared({ admit })`: every authenticated user shares the literal
 * SHARED_OWNER_ID partition, gated by an email allowlist this host parses ONCE
 * at boot from `ALLOWED_MEMBER_EMAILS`. Unlike the Worker (which reads the
 * allowlist off its own `Cloudflare.Env` per request), boot validation lets this
 * entry resolve the set once and close over it, so admit names no Cloudflare
 * type and never re-parses.
 *
 * Surface mirrors the Worker self-host: session + rooms + inference, zero
 * billing, no dashboard SPA. Blobs are intentionally not mounted; add
 * `mountBlobsApp` with `BLOBS_S3_*` set to offer a content-addressed media store
 * against any S3 (proven portable on Bun by the apps/api runtime-parity smoke).
 *
 * The wiring lives in {@link startSelfHostServer} so `server.dev.ts` can boot the
 * SAME server with a dev `resolveUser` injected (the smoke's credential) without
 * duplicating it. Production runs only when this file IS the entrypoint
 * (`import.meta.main`), so `server.dev.ts` importing the builder does not start a
 * second listener. Production passes no `resolveUser` and keeps the real OAuth
 * resolver; this file never imports the dev bypass.
 */

import {
	BunHostBindings,
	type ResolveUser,
	shared,
	startBunServer,
} from '@epicenter/server/bun';
import { type } from 'arktype';

/**
 * Boot the apps/self-host Bun server, optionally with an injected user resolver.
 *
 * Production (`server.ts` as the entrypoint) passes nothing, so
 * `createServerApp` keeps the real OAuth resolver. `server.dev.ts` passes a dev
 * `Bearer dev:<userId>` resolver so the runtime smoke needs no interactive login.
 * Everything else (env validation, pool, rooms, mounts, `Bun.serve`) is identical
 * across the two, so they cannot drift.
 */
export function startSelfHostServer(
	opts: { resolveUser?: ResolveUser } = {},
): void {
	// Validate this host's environment once, at boot (ADR-0059): the library's
	// portable secrets (`BunHostBindings` extends `ServerBindings`), this host's
	// own config, and the shared-wiki membership allowlist, so a misconfiguration
	// gets ONE descriptive error naming every missing or malformed var instead of
	// a downstream surprise. The validated result IS the typed env handed to the
	// Hono app: no `as`-cast over `process.env`, no lie. Unlike the Cloudflare
	// edge (whose bindings are deploy-gated and `wrangler types`-typed),
	// `process.env` is unchecked, so boot is the place to validate it.
	const env = BunHostBindings.merge({
		// The shared-wiki membership allowlist: comma-separated emails. Optional so
		// boot never fails on it; an unset allowlist admits nobody (fail-closed,
		// below) rather than opening the wiki to every Google account.
		'ALLOWED_MEMBER_EMAILS?': 'string',
	})(process.env);
	if (env instanceof type.errors) {
		console.error(
			`Invalid environment for the self-host server:\n${env.summary}`,
		);
		process.exit(1);
	}

	// Parse the allowlist once at boot and close over the set, so admit is a plain
	// membership test with no per-request env read or re-parse. An unset or empty
	// var yields an empty set: the deployment admits nobody until the operator
	// names members, so a missing allowlist fails closed.
	const allowedMembers = new Set(
		(env.ALLOWED_MEMBER_EMAILS ?? '')
			.split(',')
			.map((email) => email.trim())
			.filter(Boolean),
	);

	// Ownership is `shared({ admit })`: every authenticated user shares the literal
	// SHARED_OWNER_ID partition, gated by the email allowlist. A self-host trusts
	// its OWN origin and the Tauri desktop client, never Epicenter cloud's;
	// everything else is the shared Bun bootstrap.
	const { origin, dataDir } = startBunServer({
		env,
		defaultPort: 8787,
		mode: 'shared',
		ownership: shared({
			admit: (c) => allowedMembers.has(c.var.user.email),
		}),
		resolveTrustedOrigins: (baseURL) => [
			new URL(baseURL).origin,
			'tauri://localhost',
		],
		// Undefined in production; `server.dev.ts` passes a dev bearer resolver.
		resolveUser: opts.resolveUser,
	});

	console.log(
		`apps/self-host (Bun) listening on ${origin} (rooms in ${dataDir}, ${allowedMembers.size} member(s) admitted)`,
	);
}

// Run production only when this file is the entrypoint. `server.dev.ts` imports
// `startSelfHostServer` to boot the dev variant, and must not trigger a second
// listener here.
if (import.meta.main) startSelfHostServer();
