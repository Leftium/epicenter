/**
 * Open the per-person account room on the daemon: the relay floor's home.
 *
 * The account room is the per-user fleet room: an ordinary sync room at the
 * reserved guid, so it reuses every bit of room machinery (bearer auth, Y.Doc
 * sync, the WebSocket upgrade) the same way a mount's room does. `epicenter
 * daemon up` opens it alongside its mount and rides the relay floor over the one
 * connection it holds: the channel port carries cross-device tool channels, and
 * server-owned presence lists this user's other online devices.
 *
 * What this node module owns is the node-only glue the browser-safe core cannot
 * do: resolve the durable node id off disk, resolve the daemon's sync base URL,
 * and pin a deterministic Y.Doc clientID with `node:crypto`. The room itself
 * (Y.Doc at the reserved guid, sync, the channel port) is the shared
 * {@link openAccountRoomConnection} core a browser uses the same way. There is no
 * per-device signing or trust ledger; the relay floor authenticates by the
 * session's `userId`, and a route is reached on owner identity plus a
 * relay-exposed gate (see `gateway/relay-route.ts`).
 *
 * It is gated on a signed-in session: the room is bearer-authed, so a signed-out
 * daemon has no account room (it returns `null`, the room's analogue of an
 * inactive mount). The daemon treats opening it as best-effort: a failure here
 * never aborts the mount that is the daemon's actual job.
 */

import {
	type AccountRoomConnection,
	openAccountRoomConnection,
} from '../account/open-account-room-connection.js';
import { resolveDaemonNodeId } from '../config/daemon-node-id.js';
import type { WorkspaceAuthClient } from '../config/open-epicenter-root.js';
import { hashYDocClientId } from '../shared/client-id.js';
import { resolveSyncBaseURL } from './mount-runtime.js';

/** Inputs to {@link openAccountRoom}. */
export type OpenAccountRoomOptions = {
	/** The Epicenter root whose daemon is opening the room (selects the node id). */
	epicenterRoot: string;
	/**
	 * The machine auth client, or `null` when signed out. The room is opened only
	 * for a signed-in session; a signed-out daemon gets `null` back.
	 */
	auth: WorkspaceAuthClient | null;
	/** Explicit sync base URL; falls back through {@link resolveSyncBaseURL}. */
	baseURL?: string;
};

/** The daemon's account-room handle is the shared {@link AccountRoomConnection}. */
export type AccountRoomHandle = AccountRoomConnection;

/**
 * Open the account room for the signed-in user and return a handle. Returns
 * `null` when machine auth is absent or signed out (a valid state, like an
 * inactive mount): there is no account room without a bearer to auth the room
 * socket.
 */
export async function openAccountRoom(
	options: OpenAccountRoomOptions,
): Promise<AccountRoomHandle | null> {
	const { auth } = options;
	if (auth === null || auth.state.status === 'signed-out') return null;
	const { ownerId } = auth.state;

	// The nodeId the relay routes by is the daemon's durable node id, shared with
	// its mount room so the device presents one identity across both rooms.
	const nodeId = resolveDaemonNodeId(options.epicenterRoot);

	return openAccountRoomConnection({
		nodeId,
		ownerId,
		baseURL: resolveSyncBaseURL(options.baseURL),
		openWebSocket: auth.openWebSocket,
		onReconnectSignal: auth.onStateChange,
		// The daemon pins a stable clientID so its writes merge under one CRDT
		// identity across restarts; the browser omits it (the account doc carries
		// no data) to stay free of `node:crypto`.
		clientId: hashYDocClientId(nodeId),
	});
}
