/**
 * @epicenter/server/bun — the Bun host surface.
 *
 * Same library, second runtime (ADR-0059). A Bun entry imports `createServerApp`
 * and the `mount*` surface from here and builds an inline `RuntimeAdapter` from
 * plain primitives: a `pg.Pool` for `connectDb`, a fire-and-forget
 * `afterResponse`, and {@link createBunRooms} for `resolveRooms` (an in-process
 * registry over `bun:sqlite`, not a Durable Object). There is no `bun()` factory
 * mirroring `cloudflare()`: that triple is verbatim-duplicated across the two
 * Cloudflare deployables, but the Bun adapter has a single producer, so it stays
 * inline where the entry can read it. Bun is the one non-Cloudflare runtime
 * (ADR-0059): `bun:sqlite` is the built-in synchronous engine the room update
 * log needs, and `bun build --compile` is what ships the self-host binary and
 * the Tauri sidecar. There is no Node backend; this code imports `bun:sqlite`
 * and `Bun.serve` directly.
 *
 * This barrel re-exports everything the main barrel does EXCEPT the Cloudflare
 * `Room` Durable Object class, whose module imports `cloudflare:workers` and so
 * cannot load in a Bun process. `createDurableObjectRooms` and
 * `connectHyperdriveDb` are also omitted: the Cloudflare bindings have no place
 * on a Bun host, which supplies its own room and db concerns.
 */

export { createDb, type Db } from './db/create-db.js';
export {
	requireBearerUser,
	requireCookieOrBearerUser,
} from './middleware/require-auth.js';
export { doName } from './owner.js';
export {
	type Admit,
	type OwnershipRule,
	personal,
	shared,
} from './ownership.js';
// The Bun room backend: an in-process Rooms map + bun:sqlite update log,
// plus the Bun `websocket` handler and `bindServer` the entry wires.
export { createBunRooms } from './room/backends/bun/registry.js';
export { authApp } from './routes/auth.js';
export { mountBlobsApp } from './routes/blobs.js';
export { mountInferenceApp } from './routes/inference.js';
export { mountRoomsApp } from './routes/rooms.js';
export { mountSessionApp } from './routes/session.js';
export {
	createServerApp,
	type Identity,
	type RuntimeAdapter,
} from './server-app.js';
// The portable env contract as both arktype schema (value) and inferred type;
// the Bun entry validates `process.env` against it at boot.
export { ServerBindings } from './server-bindings.js';
// `ResolveUser` is the user-resolution seam the dev Bun entry injects on
// `createServerApp` to drive the parity smoke without an interactive login.
export type { Env, ResolveUser } from './types.js';
