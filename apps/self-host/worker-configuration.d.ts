/**
 * Cloudflare bindings for apps/self-host.
 *
 * Hand-written so this reference deployable typechecks without requiring a
 * Cloudflare account or a `wrangler types` run. The library's binding
 * contract is inherited from `ServerBindings`, so this file declares only
 * what the deployment itself owns. If you replace it with `wrangler types`
 * output, re-add the `extends` clause so the inherited bindings (GitHub
 * OAuth, AI provider house keys) survive the regeneration.
 *
 * Hosted-only bindings (Autumn, ASSETS, ADMIN_USER_IDS) are deliberately
 * absent: the shared-wiki reference has no billing surface and no
 * dashboard SPA.
 */

/// <reference types="@cloudflare/workers-types" />

declare namespace Cloudflare {
	// Heritage clauses cannot contain import() type expressions (TS2499),
	// so the library contract is aliased before the extends.
	type ServerBindings = import('@epicenter/server').ServerBindings;

	interface Env extends ServerBindings {
		// Runtime-only Cloudflare bindings the library no longer names in
		// ServerBindings (ADR-0066): this deployment reads them in its own
		// `connectDb`/`resolveRooms` resolvers, so it declares them here.
		HYPERDRIVE: Hyperdrive;
		ROOM: DurableObjectNamespace<import('@epicenter/server').Room>;
		// Deployment-owned vars (wrangler.jsonc): this deployment's public
		// origin and the shared() admission allowlist. The library never
		// reads these by name; they flow through deployment callbacks.
		API_PUBLIC_ORIGIN: string;
		ALLOWED_MEMBER_EMAILS: string;
	}
}

interface Env extends Cloudflare.Env {}
