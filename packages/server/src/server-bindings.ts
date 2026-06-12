/**
 * Cloudflare bindings the `@epicenter/server` library reads from `c.env`.
 *
 * Single source of truth for the library's binding contract. The library's
 * own program applies it to `Cloudflare.Env` through the ambient shim in
 * cloudflare-bindings.d.ts; each deployment proves its own Env declaration
 * against it (apps/self-host extends it in worker-configuration.d.ts,
 * apps/api asserts `satisfies` in its worker entry). Assignability lets a
 * deployment strengthen the contract (a required `string` satisfies an
 * optional member), never weaken it.
 *
 * Cloud-only bindings (Autumn, admin IDs, dashboard ASSETS fetcher) live in
 * apps/api's generated worker-configuration.d.ts and never appear here.
 */

import type { Room } from './room/backends/cloudflare/durable-object.js';

export interface ServerBindings {
	// The deployment's public origin is NOT read from `c.env` here. The
	// hosted cloud bakes a constant while a self-host reads operator
	// config, so each deployment hands `createServerApp` its own
	// `resolveOrigin(env)` instead of the library reaching for a shared
	// var name. See server-app.ts.
	HYPERDRIVE: Hyperdrive;
	ROOM: DurableObjectNamespace<Room>;
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
	// house key exists (see routes/ai.ts). Hosted requires both at deploy
	// time; see apps/api/wrangler.jsonc for why.
	OPENAI_API_KEY?: string;
	GEMINI_API_KEY?: string;
}
