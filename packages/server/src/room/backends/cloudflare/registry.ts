/**
 * `Rooms` over a Cloudflare `DurableObjectNamespace`.
 *
 * Wraps Cloudflare's namespace + stub primitives so consumers see only
 * the runtime-agnostic {@link ResolvedRoom} surface. The Cloudflare
 * `idFromName` derivation and the `fetch`-as-upgrade convention live
 * here; route middleware in `app.ts` calls `rooms.get(name)` and never
 * touches `c.env.ROOM` directly.
 */

import type { ResolvedRoom, Rooms } from '../../contracts';
import type { Room } from './durable-object';

/**
 * Build a {@link Rooms} that resolves opaque room names to Durable
 * Object stubs.
 *
 * The returned `get(name)` is cheap (one `idFromName` + one `get`);
 * the stub itself is lazy until an RPC or `fetch` is invoked on it.
 *
 * @param namespace - The `ROOM` binding from `wrangler.jsonc`, typed via
 *   the generated `worker-configuration.d.ts`.
 */
export function createDurableObjectRooms(
	namespace: DurableObjectNamespace<Room>,
) {
	return {
		/**
		 * Resolve a room by its host-owned opaque name (built by
		 * `doName(ownerId, roomId)`, producing `owners/<ownerId>/rooms/<roomId>`
		 * in both modes: in personal mode `ownerId === user.id`, in shared mode
		 * `ownerId === 'shared'`).
		 *
		 * Returns a {@link ResolvedRoom} whose methods forward to the DO
		 * stub: RPC for `sync` and `getDoc`, and `fetch` for the
		 * WebSocket upgrade (the only path that needs HTTP semantics).
		 */
		get(name: string): ResolvedRoom {
			const stub = namespace.get(namespace.idFromName(name));
			return {
				sync: (body) => stub.sync(body),
				getDoc: () => stub.getDoc(),
				// The DO reads `userId`/`nodeId` from the forwarded request URL.
				// `nodeId` already rides the client's URL; stamp the server-resolved
				// `userId` over any client-supplied value, then forward to the stub
				// (a 101-returning `fetch`). Reconstructing the request is fine here
				// because Cloudflare matches the socket by the DO it routes to, not
				// by request-object identity the way Bun's `server.upgrade` does.
				handleUpgrade: ({ request, userId }) => {
					const url = new URL(request.url);
					url.searchParams.set('userId', userId);
					return stub.fetch(new Request(url.toString(), request));
				},
			} satisfies ResolvedRoom;
		},
	} satisfies Rooms;
}
