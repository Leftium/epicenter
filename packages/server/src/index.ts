/**
 * @epicenter/server
 *
 * One shared Hono library, two deployables (ADR-0074): the hosted Epicenter
 * Cloud (`personal`, multi-tenant, partition keyed per user) and the self-hosted
 * single-partition instance (`instance`, one pinned `owners/instance` partition
 * behind one operator bearer). The full design lives in
 * `specs/20260522T230000-server-package-split.md`.
 *
 * Deployments construct the server app, choose an `OwnershipRule`, then
 * mount each reusable surface with the matching `mount*` primitive. Each
 * primitive owns its auth + ownership wiring; the deployment passes only
 * the rule and any deployment policies (e.g. cloud billing middleware).
 * Sub-apps declare full URLs (including the `/api` prefix where
 * applicable). See `apps/api/worker/index.ts` for the cloud composition.
 */

// The single-partition instance's bearer VERIFIER (self-host; ADR-0074). The
// deployment injects `createInstanceTokenResolver(verifyEnvToken(secret))` as its
// `ResolveUser` (paired with `instance()`). The pure generator + boot entropy gate
// (`generateInstanceToken` / `assertStrongToken`) live in `@epicenter/auth`.
export {
	createInstanceTokenResolver,
	INSTANCE_PRINCIPAL,
	type VerifyToken,
	verifyEnvToken,
} from './auth/instance-token.js';
// Database concern. `createDb(client)` wraps a connected pg client/pool in
// drizzle with the internal schema (the portable core). The Cloudflare
// per-request `pg.Client` over Hyperdrive is now internal to the `cloudflare()`
// runtime adapter (runtime/cloudflare.ts); a Bun host builds its own
// `pg.Pool`-backed adapter inline.
export { createDb, type Db } from './db/create-db.js';
// Deploy-time admin operations (OAuth client seeding) live in each
// deployment's own scripts (`apps/api` `oauth:seed:*`), not in this barrel, so
// `pg` and the drizzle query-builder graph stay out of the worker's module and
// type programs. The seed builds rows from `projectTrustedOAuthClientToRow` in
// `@epicenter/constants/oauth` (beside `buildTrustedOAuthClients`, its input),
// so it never imports this request-path auth barrel.
//
// Auth middleware + the cloud's OAuth bearer resolver. A deployment passes one of
// these as the `auth` for each owner-scoped mount (the cloud passes
// `requireCookieOrBearerUser`, an instance `requireBearerUser`) and passes
// `resolveRequestOAuthUser` as `createServerApp`'s `resolveUser` (the cloud's user
// resolution; an instance passes its bearer resolver instead, ADR-0074).
export {
	requireBearerUser,
	requireCookieOrBearerUser,
	resolveRequestOAuthUser,
} from './middleware/require-auth.js';
// An opt-in burn-rate cap for the inference `policies` seam: caps requests per
// owner partition so a shared house key cannot be run up unbounded (ADR-0075).
export { rateLimit } from './middleware/rate-limit.js';
// The cloud-only relational-auth layer: per-request Better Auth on `c.var.auth`
// plus the `authApp` surface (sign-in, consent, OAuth metadata). The cloud calls
// this once after `createServerApp`; the single-partition instance never does and
// composes no Better Auth or Postgres (ADR-0074).
export { mountCloudAuth } from './mount-cloud-auth.js';
// `doName` builds a room's owner-scoped DO name, deployment-agnostic and
// exported for composing apps. The Cloudflare room registry
// (`createDurableObjectRooms`) is now internal to the `cloudflare()` runtime
// adapter (runtime/cloudflare.ts).
export { doName } from './owner.js';
// Ownership composition: the deployment constructs the rule once via
// `personal()` (Cloud, multi-tenant) or `instance()` (self-host, one pinned
// partition) and threads it into every mount primitive that needs the
// partition. See ./ownership.ts for the design note.
export { instance, type OwnershipRule, personal } from './ownership.js';
// Re-export the Cloudflare Durable Object class so each deployment's
// wrangler.jsonc can resolve `class_name: "Room"` against this entrypoint.
export { Room } from './room/backends/cloudflare/durable-object.js';
// Reusable surfaces. Each `mount*` bundles auth + ownership + the route
// mount, accepting only the deployment-controlled knobs (ownership rule,
// auth choice, optional policies). The cloud's Better Auth surface (sessions,
// OAuth, `c.var.auth`) is bundled into `mountCloudAuth`; an instance composes
// none of it (ADR-0074).
export { mountBlobsApp } from './routes/blobs.js';
export { mountInferenceApp } from './routes/inference.js';
export { mountRoomsApp } from './routes/rooms.js';
export { mountSessionApp } from './routes/session.js';
export { bun } from './runtime/bun.js';
// The Cloudflare runtime adapter: the per-runtime triple (db over Hyperdrive,
// `waitUntil`, the Durable Object room registry) as one `RuntimeAdapter` both
// Cloudflare deployables pass to `createServerApp`'s `runtime`. `bun()` is its
// honest peer for a Bun host (same return type; wraps boot-built primitives
// instead of extracting per request). Bun entries usually reach it through the
// `@epicenter/server/bun` barrel.
export { cloudflare } from './runtime/cloudflare.js';
// Parent app. Wires per-request lifecycle (pg, after-response queue,
// auth context, CORS, CSRF, rooms registry). Mount every surface on this
// app via the `mount*` primitives. It takes two axes: a `RuntimeAdapter` (how
// this runtime does the three non-portable jobs) and an `Identity` (who this
// deployment is on the web).
export {
	createServerApp,
	type Identity,
	type RuntimeAdapter,
} from './server-app.js';

// Binding contract: the portable env the library reads from `c.env`, as both
// the arktype schema (value) and its inferred type (same name). Each deployment
// proves its own Env against it (extends in apps/self-host, satisfies in
// apps/api); a Bun host validates `process.env` with the schema at boot.
export { ServerBindings } from './server-bindings.js';
// Public Hono context type the deployment composes around library
// middleware, plus the user-resolution seam a dev entry injects on
// `createServerApp` (default: the real OAuth bearer resolver).
export type { Env, ResolveUser } from './types.js';
