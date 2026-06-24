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
	// Content-addressed blob store (routes/blobs.ts). A PORTABLE S3 client:
	// the whole module talks plain S3-over-HTTPS via aws4fetch with NO Workers
	// R2 binding, so the identical code runs on this Worker (against R2) and in
	// a self-hosted Node binary (against MinIO/Garage/S3). All members are
	// optional: a deployment without object storage simply does not mount
	// `mountBlobsApp`, and the route 503s if reached without an endpoint +
	// credentials. `BLOBS_S3_ENDPOINT` is the S3 origin (for R2:
	// `https://<accountId>.r2.cloudflarestorage.com`); `BLOBS_S3_BUCKET`
	// defaults to `epicenter-blobs` and `BLOBS_S3_REGION` to `auto` (R2's
	// region) when unset.
	BLOBS_S3_ENDPOINT?: string;
	BLOBS_S3_ACCESS_KEY_ID?: string;
	BLOBS_S3_SECRET_ACCESS_KEY?: string;
	BLOBS_S3_BUCKET?: string;
	BLOBS_S3_REGION?: string;
	BETTER_AUTH_SECRET: string;
	GOOGLE_CLIENT_ID: string;
	GOOGLE_CLIENT_SECRET: string;
	// GitHub is optional: a deployment that has not registered a GitHub
	// OAuth app simply does not offer GitHub sign-in. The provider and its
	// sign-in button are both gated on these being present (see
	// create-auth.ts and the `/sign-in` route).
	GITHUB_CLIENT_ID?: string;
	GITHUB_CLIENT_SECRET?: string;
	// AI provider house keys are optional: set one to serve that provider
	// through the gateway (routes/inference.ts), or omit it and a request for
	// that provider gets 503 ProviderNotConfigured. The gateway is
	// house-key-only (ADR-0054); a user's own key lives on a custom client
	// backend, never here. Hosted requires both at deploy time; see
	// apps/api/wrangler.jsonc for why.
	OPENAI_API_KEY?: string;
	GEMINI_API_KEY?: string;
}
