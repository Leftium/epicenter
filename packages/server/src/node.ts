/**
 * @epicenter/server/node — the Node/Bun host surface.
 *
 * Same library, second runtime (ADR-0057). A Bun or Node entry imports
 * `createServerApp` and the `mount*` surface from here and binds the runtime
 * concerns to plain primitives: a `pg.Pool` for `connectDb`, a fire-and-forget
 * `afterResponse`, and {@link createNodeRooms} for `resolveRooms` (an
 * in-process registry over `bun:sqlite`, not a Durable Object).
 *
 * This barrel re-exports everything the main barrel does EXCEPT the Cloudflare
 * `Room` Durable Object class, whose module imports `cloudflare:workers` and so
 * cannot load in a Node or Bun process. `createDurableObjectRooms` and
 * `connectHyperdriveDb` are also omitted: the Cloudflare bindings have no place
 * on a Node host, which supplies its own room and db concerns.
 */

export {
	requireBearerUser,
	requireCookieOrBearerUser,
} from './middleware/require-auth.js';
export { type Db, createDb } from './db/create-db.js';
export { doName } from './owner.js';
export {
	type Admit,
	type OwnershipRule,
	personal,
	shared,
} from './ownership.js';
export { authApp } from './routes/auth.js';
export { mountBlobsApp } from './routes/blobs.js';
export { mountInferenceApp } from './routes/inference.js';
export { mountRoomsApp } from './routes/rooms.js';
export { mountSessionApp } from './routes/session.js';
export { createServerApp } from './server-app.js';
// The Node room backend: an in-process Rooms map + bun:sqlite update log,
// plus the Bun `websocket` handler and `bindServer` the entry wires.
export { createNodeRooms } from './room/backends/node/registry.js';
export type { ServerBindings } from './server-bindings.js';
export type { Env } from './types.js';
