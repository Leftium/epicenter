/**
 * `RoomRegistry` over a Cloudflare `DurableObjectNamespace`.
 *
 * Wraps Cloudflare's namespace + stub primitives so consumers see only
 * the runtime-agnostic {@link RoomHandle} surface. The Cloudflare
 * `idFromName` derivation and the `fetch`-as-upgrade convention live
 * here; route middleware in `app.ts` calls `registry.getRoom(name)` and
 * never touches `c.env.ROOM` directly.
 */

import type { RoomHandle, RoomRegistry } from '../../contracts';
import type { Room } from './durable-object';

/**
 * Build a {@link RoomRegistry} that resolves opaque room names to
 * Durable Object stubs.
 *
 * The returned `getRoom(name)` is cheap (one `idFromName` + one `get`);
 * the stub itself is lazy until an RPC or `fetch` is invoked on it.
 *
 * @param namespace - The `ROOM` binding from `wrangler.jsonc`, typed via
 *   the generated `worker-configuration.d.ts`.
 */
export function createDurableObjectRoomRegistry(
	namespace: DurableObjectNamespace<Room>,
) {
	return {
		/**
		 * Resolve a room by its host-owned opaque name (e.g.
		 * `subject:<userId>:rooms:<guid>`).
		 *
		 * Returns a {@link RoomHandle} whose methods forward to the DO
		 * stub: RPC for `sync` and `getDoc`, and `fetch` for the
		 * WebSocket upgrade (the only path that needs HTTP semantics).
		 */
		getRoom(name: string): RoomHandle {
			const stub = namespace.get(namespace.idFromName(name));
			return {
				sync: (body) => stub.sync(body),
				getDoc: () => stub.getDoc(),
				handleUpgrade: (request) => stub.fetch(request),
			} satisfies RoomHandle;
		},
	} satisfies RoomRegistry;
}
