/**
 * The Bun runtime adapter: the three runtime-port concerns (ADR-0065) wired to
 * plain process primitives, as one {@link RuntimeAdapter} a Bun host passes to
 * `createServerApp`. The honest peer of {@link cloudflare}: same return type,
 * different acquisition timing.
 *
 * Where `cloudflare()` takes env EXTRACTORS and builds a db client + room
 * registry PER REQUEST off the deployment's bindings, a Bun process builds both
 * ONCE at boot (a module-scope `pg.Pool`, an in-process `createBunRooms`
 * registry over `bun:sqlite`) and reuses them for the process lifetime. So this
 * factory wraps the already-built instances rather than extracting them per
 * request:
 *
 *   - `connectDb`     hands back the shared `pg.Pool`-backed handle with a no-op
 *                     close (drizzle checks a client out per query and returns
 *                     it, so there is nothing per-request to tear down).
 *   - `afterResponse` is a no-op: a long-lived Bun process needs no `waitUntil`
 *                     to outlive the response, where Cloudflare hands the work
 *                     to `executionCtx.waitUntil` to hold the isolate open.
 *   - `resolveRooms`  returns the boot-built in-process registry.
 *
 * This file names nothing Cloudflare-shaped; the Bun host's own
 * `createBunRooms` and `pg.Pool` are supplied by the entry that calls this.
 *
 * @see `runtime/cloudflare.ts` for the per-request Cloudflare peer.
 */

import type { Db } from '../db/create-db.js';
import type { Rooms } from '../room/contracts.js';
import type { RuntimeAdapter } from '../server-app.js';

/**
 * Build the Bun {@link RuntimeAdapter} for `createServerApp` from a process's
 * boot-built db handle and room registry.
 */
export function bun({ db, rooms }: { db: Db; rooms: Rooms }): RuntimeAdapter {
	return {
		connectDb: async () => ({ db, close: async () => {} }),
		afterResponse: () => {},
		resolveRooms: () => rooms,
	};
}
