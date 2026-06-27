/**
 * Epicenter self-hosted instance Worker (Cloudflare; ADR-0074).
 *
 * The instance on Cloudflare: the SAME `@epicenter/server` composition the Bun
 * entry (`server.ts`) builds, wired to Cloudflare bindings instead of plain
 * primitives (ADR-0066). One single-partition instance, not a shared wiki and not
 * a mode: ownership is `instance()` (every request resolves to the pinned
 * `owners/instance` partition), and authentication is one operator-supplied static
 * bearer (`INSTANCE_TOKEN`), constant-time compared. No OAuth, no allowlist, no
 * sessions. "Solo" vs "shared" is only how many people hold the token.
 *
 * This is a reference, not an Epicenter-operated product. Copy this folder, set
 * `INSTANCE_TOKEN` (`wrangler secret put INSTANCE_TOKEN`, generated with
 * `bun run gen-token`), provision your Durable Object binding, and deploy. The
 * instance composes no Better Auth and no Postgres, so there is no Hyperdrive
 * binding and no `BETTER_AUTH_SECRET` (ADR-0074). Community-supported.
 *
 * Trust boundary: the deployer operates the infrastructure. Epicenter never holds
 * or sees the data stored here, so self-hosting is functionally zero-knowledge
 * against Epicenter.
 */

import { assertStrongToken } from '@epicenter/auth';
import {
	cloudflare,
	createInstanceTokenResolver,
	createServerApp,
	instance,
	mountInferenceApp,
	mountRoomsApp,
	mountSessionApp,
	rateLimit,
	Room,
	requireBearerUser,
	verifyEnvToken,
} from '@epicenter/server';

const ownership = instance();

const app = createServerApp({
	// The Cloudflare runtime adapter: the Durable Object room registry only. The
	// instance composes no Postgres (no Better Auth, no telemetry), so it passes no
	// Hyperdrive binding and `createServerApp` installs no db lifecycle (ADR-0074).
	// This edge points it at its OWN binding (the `Cloudflare.Env` cast stays here,
	// type-checked against this Worker's generated bindings, ADR-0066).
	runtime: cloudflare({
		room: (env) => (env as Cloudflare.Env).ROOM,
	}),
	identity: {
		// Self-hosters set their own public origin in wrangler.jsonc
		// (`API_PUBLIC_ORIGIN`): their domain, not Epicenter Cloud's.
		resolveOrigin: (env) => (env as Cloudflare.Env).API_PUBLIC_ORIGIN,
		// A self-host trusts its OWN origin and the Tauri desktop client, never
		// Epicenter cloud's. Add any browser app origins you serve here.
		resolveTrustedOrigins: (baseURL) => [
			new URL(baseURL).origin,
			'tauri://localhost',
		],
	},
	// The instance authenticates one operator-supplied bearer. On Cloudflare the
	// secret lives on the per-request `c.env` (a Worker has no module-scope env),
	// so the resolver reads `INSTANCE_TOKEN` at the honest edge each request
	// (ADR-0066). `assertStrongToken` runs the SAME entropy gate the Bun entry runs
	// at boot, so a missing or weak token fails closed on Cloudflare too (ADR-0074's
	// entropy floor): a Worker has no boot phase, so the gate runs per request and a
	// throw surfaces as a 500 instead of admitting a weak credential. It also
	// returns the trimmed token, so there is no `?? ''` coalesce whose removal could
	// silently let an unset secret reach the compare.
	resolveUser: (c) =>
		createInstanceTokenResolver(
			verifyEnvToken(
				assertStrongToken((c.env as Cloudflare.Env).INSTANCE_TOKEN),
			),
		)(c),
});

app.get('/', (c) =>
	c.json({ product: 'instance', version: '0.1.0', runtime: 'cloudflare' }),
);

// No `mountCloudAuth`: the instance composes no Better Auth and no sessions. The
// operator bearer (the `resolveUser` above) is the only gate, so every surface is
// bearer-authenticated (ADR-0074).
mountSessionApp(app, { ownership, auth: requireBearerUser });
mountRoomsApp(app, { ownership });
// Cap the inference burn rate so a leaked or overused bearer cannot run the
// operator's house key up unbounded. Per-isolate on Cloudflare (approximate);
// the real ceiling is the hard spend limit on the provider key itself (README).
mountInferenceApp(app, {
	auth: requireBearerUser,
	ownership,
	policies: [rateLimit({ requests: 120, windowSeconds: 60 })],
});

export default app;
export { Room };
