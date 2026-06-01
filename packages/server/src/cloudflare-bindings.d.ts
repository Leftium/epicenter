/**
 * Cloudflare bindings the `@epicenter/server` library reads from `c.env`.
 *
 * Each consuming deployment (apps/api for hosted personal cloud,
 * apps/self-host for self-hosted shared wiki) merges its own `Cloudflare.Env`
 * via `wrangler types`. This
 * declaration teaches the library compiler that the names it reads are
 * required to exist on `Cloudflare.Env`. Optional cloud-only bindings
 * (Autumn, admin IDs, dashboard ASSETS fetcher) live in apps/api's
 * generated worker-configuration.d.ts and never appear here.
 */
declare global {
	namespace Cloudflare {
		interface Env {
			// The deployment's public origin is NOT read from `c.env` here. The
			// hosted cloud bakes a constant while a self-host reads operator
			// config, so each deployment hands `createServerApp` its own
			// `resolveOrigin(env)` instead of the library reaching for a shared
			// var name. See server-app.ts.
			HYPERDRIVE: Hyperdrive;
			ROOM: DurableObjectNamespace<
				import('./room/backends/cloudflare/durable-object.js').Room
			>;
			ASSETS_BUCKET: R2Bucket;
			SESSION_KV: KVNamespace;
			ENCRYPTION_SECRETS: string;
			BETTER_AUTH_SECRET: string;
			GOOGLE_CLIENT_ID: string;
			GOOGLE_CLIENT_SECRET: string;
			// GitHub is optional: a deployment that has not registered a GitHub
			// OAuth app simply does not offer GitHub sign-in. The provider and its
			// sign-in button are both gated on these being present (see
			// create-auth.ts and the `/sign-in` route).
			GITHUB_CLIENT_ID?: string;
			GITHUB_CLIENT_SECRET?: string;
			OPENAI_API_KEY: string;
			GEMINI_API_KEY: string;
		}
	}
}

export {};
