/**
 * Cloudflare bindings for apps/team-api.
 *
 * Hand-written so this reference deployable typechecks without requiring a
 * Cloudflare account or a `wrangler types` run. Deployers should regenerate
 * via `bun run typegen` after customizing `wrangler.jsonc`.
 *
 * Bindings mirror those declared in `wrangler.jsonc` and the cloudflare
 * bindings the `@epicenter/server` library reads from `c.env`. Hosted-only
 * bindings (Autumn, ASSETS, ADMIN_USER_IDS) are deliberately absent: the
 * team reference has no billing surface and no dashboard SPA.
 */

/// <reference types="@cloudflare/workers-types" />

declare namespace Cloudflare {
	interface Env {
		// KV: Better Auth secondary storage
		SESSION_KV: KVNamespace;
		// R2: Asset storage
		ASSETS_BUCKET: R2Bucket;
		// Hyperdrive: Postgres connection pool
		HYPERDRIVE: Hyperdrive;
		// Durable Object: Yjs sync rooms
		ROOM: DurableObjectNamespace<import('./worker/index').Room>;
		// vars (wrangler.jsonc)
		API_PUBLIC_ORIGIN: string;
		ALLOWED_MEMBER_EMAILS: string;
		GOOGLE_CLIENT_ID: string;
		// secrets (wrangler secret put)
		BETTER_AUTH_SECRET: string;
		ENCRYPTION_SECRETS: string;
		GOOGLE_CLIENT_SECRET: string;
		OPENAI_API_KEY: string;
		GEMINI_API_KEY: string;
	}
}

interface Env extends Cloudflare.Env {}
