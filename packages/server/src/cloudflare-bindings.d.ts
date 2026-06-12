/**
 * Cloudflare bindings the `@epicenter/server` library reads from `c.env`.
 *
 * This file is only in the library's own TS program. Each consuming
 * deployment declares `Cloudflare.Env` from exactly one source of its own:
 * apps/api via `wrangler types`, apps/self-host via its hand-written
 * worker-configuration.d.ts. The declarations are never merged across
 * packages, and must not be: `wrangler types` emits literal-typed vars and
 * required secrets that would conflict with the `string`/optional members
 * here. Keep this file and the deployments' Env declarations in agreement
 * by hand. Cloud-only bindings (Autumn, admin IDs, dashboard ASSETS
 * fetcher) live in apps/api's generated file and never appear here.
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
			// AI provider house keys are optional: a deployment that omits one
			// serves only BYOK requests for that provider, and /api/ai/chat
			// returns 503 ProviderNotConfigured when neither a caller key nor a
			// house key exists (see routes/ai.ts). The hosted cloud requires
			// both in apps/api/wrangler.jsonc because credits are billed
			// against house-key usage.
			OPENAI_API_KEY?: string;
			GEMINI_API_KEY?: string;
		}
	}
}

export {};
