/**
 * The portable env contract `@epicenter/server` reads, as BOTH an arktype
 * schema (the runtime value) and its inferred type (the same name, the
 * `AuthUser` convention). It is the `Env.Bindings` type the Hono context uses
 * (see types.ts) and the SSOT a Bun host validates `process.env` against at
 * boot (see apps/api/server.ts).
 *
 * Deliberately NOT `Cloudflare.Env` (ADR-0066): it lists only the portable
 * STRING secrets library code reads, so library code names no Cloudflare type
 * and a Bun host typechecks AND validates with no Cloudflare types in scope.
 * Because every member is a string, a Bun entry runs the schema over
 * `process.env` and gets a typed env with no cast; a missing or malformed
 * secret fails fast with a descriptive error instead of a downstream surprise.
 *
 * What is deliberately ABSENT, and why:
 * - Object / namespace bindings (`ROOM` Durable Object, `HYPERDRIVE`) are not
 *   strings and cannot be validated from `process.env`. They live on the
 *   deployment's own `Cloudflare.Env` and are read by deployment resolvers at
 *   the `apps/*` edge (`resolveRooms`, `db.connect`), never by library code
 *   reaching for a binding shape. With the assets route retired into the
 *   portable blob store, the library now names NO Cloudflare object binding,
 *   by value or by type.
 * - The deployment's public origin and any cloud-only secrets (Autumn, admin
 *   IDs) are deployment config, supplied through `resolveOrigin` / policies.
 *
 * Each deployment's real env is a superset assignable to this: apps/api asserts
 * `satisfies ServerBindings` on its generated `Cloudflare.Env`, apps/self-host
 * declares `extends ServerBindings`, and the Bun host's validated `process.env`
 * is exactly this shape.
 */

import { type } from 'arktype';

export const ServerBindings = type({
	// The Better Auth signing secret, optional because Better Auth is a cloud-only
	// layer (`mountCloudAuth`): the hosted cloud sets it and re-requires it in its
	// own boot validation (apps/api/server.ts), while the single-partition instance
	// composes no Better Auth and never reads it (ADR-0073). Same register-when-
	// present precedent as the OAuth secrets below: optional here, required by the
	// deployment that actually uses it.
	'BETTER_AUTH_SECRET?': 'string',
	// Every OAuth provider is optional and register-when-present (ADR-0071): a
	// deployment that has not registered an app for a provider simply does not
	// offer that sign-in (create-auth.ts gates each one, /sign-in hides the
	// button). The hosted star always offers Google and re-requires it in its OWN
	// boot validation (apps/api/server.ts); the single-partition instance runs no
	// OAuth at all and authenticates with one operator-supplied bearer instead
	// (ADR-0073). Loosening Google here is what lets a bearer-only box boot without
	// registering a Google app for its own origin (the ADR-0070 wart).
	'GOOGLE_CLIENT_ID?': 'string',
	'GOOGLE_CLIENT_SECRET?': 'string',
	'GITHUB_CLIENT_ID?': 'string',
	'GITHUB_CLIENT_SECRET?': 'string',
	// Content-addressed blob store (routes/blobs.ts): a portable S3 client over
	// aws4fetch with NO Workers R2 binding, so the identical code runs on the
	// Worker (against R2) and on a Bun host (against Garage/S3). All
	// optional: a deployment without object storage does not mount
	// `mountBlobsApp`, and the route 503s if reached unconfigured.
	// `BLOBS_S3_BUCKET` defaults to `epicenter-blobs` and `BLOBS_S3_REGION` to
	// `auto` (R2's region) when unset.
	'BLOBS_S3_ENDPOINT?': 'string',
	'BLOBS_S3_ACCESS_KEY_ID?': 'string',
	'BLOBS_S3_SECRET_ACCESS_KEY?': 'string',
	'BLOBS_S3_BUCKET?': 'string',
	'BLOBS_S3_REGION?': 'string',
	// AI provider house keys are optional: set one to serve that provider
	// through the gateway (routes/inference.ts), or omit it and a request for
	// that provider gets 503 ProviderNotConfigured. House-key-only (ADR-0054).
	'OPENAI_API_KEY?': 'string',
	'GEMINI_API_KEY?': 'string',
});

/** The portable env contract; also the Hono `Env.Bindings` type (types.ts). */
export type ServerBindings = typeof ServerBindings.infer;
