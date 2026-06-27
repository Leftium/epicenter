/**
 * @epicenter/server/bun — the Bun host surface.
 *
 * Same library, second runtime (ADR-0066). A Bun entry imports `startBunServer`
 * (or `createServerApp` + the `mount*` surface) from here. The `RuntimeAdapter`
 * is built by {@link bun}, the honest peer of `cloudflare()`: a `pg.Pool` for
 * `connectDb`, a fire-and-forget `afterResponse`, and {@link createBunRooms} for
 * `resolveRooms` (an in-process registry over `bun:sqlite`, not a Durable
 * Object). Bun is the one non-Cloudflare runtime (ADR-0066): `bun:sqlite` is the
 * built-in synchronous engine the room update log needs, and `bun build
 * --compile` is what ships the self-host binary and the Tauri sidecar. There is
 * no Node backend; this code imports `bun:sqlite` and `Bun.serve` directly.
 *
 * This barrel re-exports everything the main barrel does EXCEPT the Cloudflare
 * `Room` Durable Object class, whose module imports `cloudflare:workers` and so
 * cannot load in a Bun process. `createDurableObjectRooms` and
 * `connectHyperdriveDb` are also omitted: the Cloudflare bindings have no place
 * on a Bun host, which supplies its own room and db concerns.
 */

// The single-partition instance's bearer VERIFIER (self-host; ADR-0073): the
// `ResolveUser` a Bun instance injects (`createInstanceTokenResolver(verifyEnvToken(token))`,
// paired with `instance()`). The pure generator + boot entropy gate
// (`generateInstanceToken` / `assertStrongToken`) live in `@epicenter/auth`.
export {
	createInstanceTokenResolver,
	INSTANCE_PRINCIPAL,
	type VerifyToken,
	verifyEnvToken,
} from './auth/instance-token.js';
export { createDb, type Db } from './db/create-db.js';
export {
	requireBearerUser,
	requireCookieOrBearerUser,
} from './middleware/require-auth.js';
export { doName } from './owner.js';
export { instance, type OwnershipRule, personal } from './ownership.js';
// The Bun room backend: an in-process Rooms map + bun:sqlite update log,
// plus the Bun `websocket` handler and `bindServer` the entry wires.
export { createBunRooms } from './room/backends/bun/registry.js';
export { authApp } from './routes/auth.js';
export { mountBlobsApp } from './routes/blobs.js';
export { mountInferenceApp } from './routes/inference.js';
export {
	mountRoomsApp,
	type RoomAccessRecorder,
	recordRoomAccessOnDb,
} from './routes/rooms.js';
export { mountSessionApp } from './routes/session.js';
// The Bun RuntimeAdapter factory: wraps a boot-built db handle + room registry,
// the honest peer of `cloudflare()`.
export { bun } from './runtime/bun.js';
export {
	createServerApp,
	type Identity,
	type RuntimeAdapter,
} from './server-app.js';
// The portable env contract as both arktype schema (value) and inferred type;
// the Bun entry validates `process.env` against it at boot.
export { ServerBindings } from './server-bindings.js';
// The shared Bun process bootstrap: an entry validates `process.env` against
// `BunHostBindings` (merging its own extras), builds its ownership rule, then
// hands both to `startBunServer`, which owns everything mechanical (pool, rooms,
// the `bun()` adapter, the shared mounts, and `Bun.serve`).
export {
	BunHostBindings,
	type StartBunServerOptions,
	startBunServer,
} from './start-bun-server.js';
// `ResolveUser` is the user-resolution seam the dev Bun entry injects on
// `createServerApp` to drive the parity smoke without an interactive login.
export type { Env, ResolveUser } from './types.js';
