/**
 * Epicenter self-hosted instance Worker (Cloudflare; ADR-0073).
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
 * `bun run gen-token`) and `BETTER_AUTH_SECRET`, provision your Cloudflare
 * bindings (Hyperdrive, Durable Objects), and deploy. Community-supported.
 *
 * Trust boundary: the deployer operates the infrastructure. Epicenter never holds
 * or sees the data stored here, so self-hosting is functionally zero-knowledge
 * against Epicenter.
 */

import {
	authApp,
	cloudflare,
	createInstanceTokenResolver,
	createServerApp,
	instance,
	mountInferenceApp,
	mountRoomsApp,
	mountSessionApp,
	Room,
	requireBearerUser,
	verifyEnvToken,
} from '@epicenter/server';

const ownership = instance();

const app = createServerApp({
	// The Cloudflare runtime adapter: a per-request pg client over Hyperdrive,
	// `waitUntil` to drain the after-response queue, and the Durable Object room
	// registry. This edge points it at its OWN two bindings (the `Cloudflare.Env`
	// cast stays here, type-checked against this Worker's generated bindings,
	// ADR-0066). Identical wiring to the Bun entry; the runtime is all that differs.
	runtime: cloudflare({
		hyperdrive: (env) => (env as Cloudflare.Env).HYPERDRIVE,
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
	// (ADR-0066); an unset or rotated secret simply stops matching (fail closed).
	// The Bun entry reads it once at boot and runs the entropy gate; on Cloudflare
	// the operator supplies a strong secret via `wrangler secret put` (generated
	// with `bun run gen-token`).
	resolveUser: (c) =>
		createInstanceTokenResolver(
			verifyEnvToken((c.env as Cloudflare.Env).INSTANCE_TOKEN ?? ''),
		)(c),
});

app.get('/', (c) =>
	c.json({ mode: 'instance', version: '0.1.0', runtime: 'cloudflare' }),
);

// `authApp` is mounted for parity with the Bun bootstrap but is inert: the
// instance configures no OAuth provider, so there is nothing to sign in with and
// no session can be minted. The bearer resolver above is the only gate.
app.route('/', authApp);

mountSessionApp(app, { ownership });
mountRoomsApp(app, { ownership });
mountInferenceApp(app, { auth: requireBearerUser, ownership });

export default app;
export { Room };
