/**
 * # Presence Surface
 *
 * A read-only view over the workspace's presence `YKeyValueLww`. The server
 * is the only writer; peers consume `list` and `observe` to enumerate live
 * connections and pick a concrete `connectionId` to dispatch to.
 *
 * Self is always excluded by `entry.connectionId === selfConnectionId`. The
 * surface deliberately exposes only `list` and `observe`: choosing which connection
 * to target is policy, not discovery, so it belongs at the call site:
 *
 * ```ts
 * // pick any tab on a given install
 * const target = collab.peers
 *   .list()
 *   .find((p) => p.installationId === installationId);
 *
 * // exact connection
 * const target = collab.peers
 *   .list()
 *   .find((p) => p.connectionId === connectionId);
 *
 * // every tab on an install (fan-out)
 * for (const p of collab.peers.list().filter((p) => p.installationId === id)) {
 *   await collab.dispatch('action', input, { to: p.connectionId, signal });
 * }
 * ```
 *
 * Hiding a "pick the first connectionId" tie-break inside the surface would let
 * call sites read as "the macbook peer" when the real shape is one
 * installationId to many connectionIds. The explicit array operations keep the
 * choice visible.
 *
 * @module
 */

import type { YKeyValueLww } from './y-keyvalue/y-keyvalue-lww.js';

/**
 * One row in the presence store. Server-stamped on connect, deleted on
 * disconnect (or by the boot-time orphan sweep).
 *
 * - `connectionId`: server-echoed from the WebSocket query param; the
 *   per-socket routing address used by `dispatch({ to })`.
 * - `installationId`: install id (per `createInstallationId`);
 *   human-meaningful identity.
 * - `subject`: server-stamped, auth-derived (`subjectFromDoName`).
 */
export type PresenceEntry = {
	connectionId: string;
	installationId: string;
	subject: string;
};

/**
 * Create a derived view over the presence store. Self is excluded by
 * `entry.connectionId === selfConnectionId`. The returned object is stable for
 * the lifetime of the underlying store; callers can hold it across reconnects.
 */
export function createPresenceSurface(
	presence: YKeyValueLww<PresenceEntry>,
	selfConnectionId: string,
) {
	return {
		/**
		 * All peers, self excluded, sorted by `connectionId` ascending. Deterministic
		 * ordering lets multiple callers agree on "first match" without sharing
		 * state, e.g. `peers.list().find((p) => p.installationId === id)` picks the
		 * same connection in every replica that runs the same query.
		 */
		list(): PresenceEntry[] {
			const out: PresenceEntry[] = [];
			for (const [, entry] of presence.entries()) {
				if (entry.val.connectionId === selfConnectionId) continue;
				out.push(entry.val);
			}
			out.sort((a, b) =>
				a.connectionId < b.connectionId
					? -1
					: a.connectionId > b.connectionId
						? 1
						: 0,
			);
			return out;
		},

		/**
		 * Register a change listener. Returns an unobserve cleanup. The callback
		 * receives no arguments: presence consumers typically re-derive their
		 * view from `list()` rather than diff individual rows.
		 */
		observe(cb: () => void): () => void {
			const handler = () => cb();
			presence.observe(handler);
			return () => presence.unobserve(handler);
		},
	};
}

/** The public surface returned by {@link createPresenceSurface}. */
export type PresenceSurface = ReturnType<typeof createPresenceSurface>;
