/**
 * Epicenter self-hosted shared-wiki Worker (reference implementation).
 *
 * Composes `@epicenter/server` with the `shared({ admit })` ownership rule
 * and ships zero billing surface. Workspace data is partitioned under the
 * literal `SHARED_OWNER_ID` ("shared"); the admit predicate runs per request
 * against a deployment-owned email allowlist.
 *
 * This is a reference, not an Epicenter-operated product. Copy this folder,
 * fill in the deployment-owned secrets (Better Auth, OAuth provider keys,
 * AI provider keys), provision your Cloudflare bindings (Hyperdrive, R2, KV,
 * Durable Objects), and deploy. Community-supported.
 *
 * Trust boundary: the deployer operates the infrastructure. Epicenter never
 * holds or sees the data stored here, so self-hosting is functionally
 * zero-knowledge against Epicenter.
 */

import {
	authApp,
	connectHyperdriveDb,
	createDurableObjectRooms,
	createServerApp,
	mountInferenceApp,
	mountRoomsApp,
	mountSessionApp,
	Room,
	requireBearerUser,
	shared,
} from '@epicenter/server';

const ownership = shared({
	admit: (c) => {
		// `ALLOWED_MEMBER_EMAILS` is operator config on this deployment's own
		// `Cloudflare.Env`, not a library binding, so it is read with the same
		// edge cast the resolvers use (ADR-0059).
		const allowed = new Set(
			(c.env as Cloudflare.Env).ALLOWED_MEMBER_EMAILS.split(',')
				.map((s) => s.trim())
				.filter(Boolean),
		);
		return allowed.has(c.var.user.email);
	},
});

// Self-hosters set their own public origin in wrangler.jsonc (`API_PUBLIC_ORIGIN`):
// their domain, not Epicenter Cloud's. It is operator config, not a baked
// constant, so it is read straight from `c.env`.
// The library types `env` as its portable `ServerBindings`; this Worker reads
// Cloudflare-only bindings (`HYPERDRIVE`, `ROOM`) and the operator-set
// `API_PUBLIC_ORIGIN`, none of which `ServerBindings` names. Casting to this
// deployment's own `Cloudflare.Env` is the honest edge (ADR-0059).
const app = createServerApp({
	resolveOrigin: (env) => (env as Cloudflare.Env).API_PUBLIC_ORIGIN,
	// A self-host trusts its OWN origin and the Tauri desktop client, never
	// Epicenter cloud's. Add any browser app origins you serve (and the
	// Epicenter browser-extension origin, if your users point it at this
	// deployment) here.
	resolveTrustedOrigins: (baseURL) => [
		new URL(baseURL).origin,
		'tauri://localhost',
	],
	// No cookieDomain: a single-origin deployment uses host-only cookies scoped
	// to its own host.
	// Cloudflare runtime bindings: a per-request pg client over Hyperdrive, and
	// `waitUntil` to drain the after-response queue past the response.
	connectDb: (env) => connectHyperdriveDb((env as Cloudflare.Env).HYPERDRIVE),
	afterResponse: (c, work) => c.executionCtx.waitUntil(work),
	resolveRooms: (env) => createDurableObjectRooms((env as Cloudflare.Env).ROOM),
});

app.get('/', (c) =>
	c.json({ mode: 'shared', version: '0.1.0', runtime: 'cloudflare' }),
);

app.route('/', authApp);

mountSessionApp(app, { ownership });
mountRoomsApp(app, { ownership });
mountInferenceApp(app, { auth: requireBearerUser, ownership });

export default app;
export { Room };
