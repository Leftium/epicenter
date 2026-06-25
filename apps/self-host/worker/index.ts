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
	cloudflare,
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
		// `ALLOWED_MEMBER_EMAILS` is this deployment's operator config, read off
		// its own `Cloudflare.Env` (the honest-edge cast, ADR-0065; the resolver
		// note below carries the full rationale). `?? ''` keeps a deployment that
		// never set the var fail-closed (admits nobody) instead of throwing a
		// TypeError on every request: wrangler types it `string`, but a declared
		// var is not guaranteed present at runtime and self-host has no boot check.
		const allowed = new Set(
			((c.env as Cloudflare.Env).ALLOWED_MEMBER_EMAILS ?? '')
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean),
		);
		return allowed.has(c.var.user.email);
	},
});

const app = createServerApp({
	// The Cloudflare runtime adapter: a per-request pg client over Hyperdrive,
	// `waitUntil` to drain the after-response queue past the response, and the
	// Durable Object room registry. This edge points it at its OWN two bindings
	// (the `Cloudflare.Env` cast and binding names stay here, type-checked
	// against this Worker's generated bindings, ADR-0065). Identical wiring to
	// the hosted deployable; the ownership rule and identity are what differ.
	runtime: cloudflare({
		hyperdrive: (env) => (env as Cloudflare.Env).HYPERDRIVE,
		room: (env) => (env as Cloudflare.Env).ROOM,
	}),
	identity: {
		// Self-hosters set their own public origin in wrangler.jsonc
		// (`API_PUBLIC_ORIGIN`): their domain, not Epicenter Cloud's. It is
		// operator config, not a binding `ServerBindings` names, so it is read off
		// this deployment's own `Cloudflare.Env` at the honest edge (ADR-0065).
		resolveOrigin: (env) => (env as Cloudflare.Env).API_PUBLIC_ORIGIN,
		// A self-host trusts its OWN origin and the Tauri desktop client, never
		// Epicenter cloud's. Add any browser app origins you serve (and the
		// Epicenter browser-extension origin, if your users point it at this
		// deployment) here.
		resolveTrustedOrigins: (baseURL) => [
			new URL(baseURL).origin,
			'tauri://localhost',
		],
		// No cookieDomain: a single-origin deployment uses host-only cookies
		// scoped to its own host.
	},
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
