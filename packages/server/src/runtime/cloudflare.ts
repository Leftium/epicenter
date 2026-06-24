/**
 * The Cloudflare runtime adapter: the three runtime-port concerns (ADR-0059)
 * bound to Workers bindings, as one {@link RuntimeAdapter} a Workers deployment
 * passes to `createServerApp`. Both Cloudflare deployables (`apps/api`,
 * `apps/self-host`) build the identical triple, so it lives here once instead of
 * being restated at each edge.
 *
 * This is the honest edge where naming Cloudflare belongs: the adapter casts the
 * portable `ServerBindings` to the Workers binding shape it knows is really
 * there (`HYPERDRIVE`, `ROOM`), reading the binding objects the library's env
 * contract deliberately does not name. A Bun host builds its own adapter inline
 * over a `pg.Pool`, a no-op, and an in-process room registry instead.
 */

import { connectHyperdriveDb } from '../db/backends/cloudflare.js';
import { createDurableObjectRooms } from '../room/backends/cloudflare/registry.js';
import type { RuntimeAdapter } from '../server-app.js';
import type { ServerBindings } from '../server-bindings.js';

/**
 * The portable `ServerBindings` plus the two Workers object bindings the adapter
 * reads, derived from exactly what `connectHyperdriveDb` and
 * `createDurableObjectRooms` consume. `ServerBindings` holds only strings and
 * cannot name these, so the adapter narrows `env` to this superset at the one
 * honest edge — a single downcast, no `unknown` laundering.
 */
type CloudflareRuntimeBindings = ServerBindings & {
	HYPERDRIVE: Parameters<typeof connectHyperdriveDb>[0];
	ROOM: Parameters<typeof createDurableObjectRooms>[0];
};

/**
 * Build the Cloudflare {@link RuntimeAdapter} for `createServerApp`: a
 * per-request `pg.Client` over Hyperdrive, `waitUntil` to outlive the response,
 * and a Durable Object room registry. Per-room DO sharding stays the cloud's
 * binding of the room actor (ADR-0059): hibernate-to-zero and
 * single-writer-per-room at multi-tenant scale.
 */
export function cloudflare(): RuntimeAdapter {
	return {
		connectDb: (env) =>
			connectHyperdriveDb((env as CloudflareRuntimeBindings).HYPERDRIVE),
		afterResponse: (c, work) => c.executionCtx.waitUntil(work),
		resolveRooms: (env) =>
			createDurableObjectRooms((env as CloudflareRuntimeBindings).ROOM),
	};
}
