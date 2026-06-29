/**
 * Open the per-person account room on the daemon: the relay floor's home.
 *
 * The account room is the per-user fleet room: an ordinary sync room at the
 * reserved guid {@link RESERVED_ACCOUNT_ROOM_GUID}, so it reuses every bit of
 * room machinery (bearer auth, Y.Doc sync, the WebSocket upgrade) the same way a
 * mount's room does. `epicenter daemon up` opens it alongside its mount and rides
 * the relay floor over the one connection it holds: the channel port carries
 * cross-device tool channels, and server-owned presence lists this user's other
 * online devices.
 *
 * What this node module owns is the node-only glue the browser-safe room core
 * cannot do: persist the doc's update log to disk and join the room over the
 * relay. There is no per-device signing or trust ledger; the relay floor
 * authenticates by the session's `userId`, and a route is reached on owner
 * identity plus a relay-exposed gate (see `gateway/relay-route.ts`).
 *
 * It is gated on a signed-in session: the room is bearer-authed, so a signed-out
 * daemon has no account room (it returns `null`, the room's analogue of an
 * inactive mount). The daemon treats opening it as best-effort: a failure here
 * never aborts the mount that is the daemon's actual job.
 */

import * as Y from 'yjs';

import { RESERVED_ACCOUNT_ROOM_GUID } from '../account/index.js';
import { resolveDaemonNodeId } from '../config/daemon-node-id.js';
import type { WorkspaceAuthClient } from '../config/open-epicenter-root.js';
import { attachYjsLog } from '../document/attach-yjs-log.js';
import type { NodeId } from '../document/node-id.js';
import { openCollaboration } from '../document/open-collaboration.js';
import type { Peer } from '../document/presence-protocol.js';
import { roomWsUrl } from '../document/transport.js';
import { yjsPath } from '../document/workspace-paths.js';
import {
	type ChannelPort,
	createChannelPort,
} from '../relay-channel/index.js';
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

/**
 * A live account-room connection: the relay floor over one socket. `peers()`
 * reads the user's other online devices; `channelPort` carries cross-device tool
 * channels; `[Symbol.asyncDispose]` tears the doc, sync, and durable log down in
 * the same destroy-then-drain order a mount uses.
 */
export type AccountRoomHandle = {
	/** The reserved guid this room was opened at. */
	guid: string;
	/** The signed-in account owner (userId); the relay floor's authorized identity. */
	ownerId: string;
	/**
	 * This device's relay routing id and dial target: the relay routes by it (it
	 * is stamped on the account-room socket as `?nodeId=`), and a peer reaches this
	 * device by naming it.
	 */
	nodeId: NodeId;
	/**
	 * The relay-channel port over this account-room socket: the floor the
	 * relay-channel acceptor and transport ride. It carries channels to and from
	 * this user's other devices over the connection already held, no second socket.
	 */
	channelPort: ChannelPort;
	/**
	 * This account's other devices currently connected to the relay floor, from the
	 * server's live presence (newest-wins per nodeId, self excluded). You reach a
	 * device that is online, addressed by its nodeId, with no enrollment in between.
	 */
	peers(): Peer[];
	[Symbol.asyncDispose](): Promise<void>;
};

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

	const ydoc = new Y.Doc({ guid: RESERVED_ACCOUNT_ROOM_GUID });
	// Pin a deterministic clientID before any local edit, so each device's writes
	// merge under one stable CRDT identity across restarts.
	ydoc.clientID = hashYDocClientId(nodeId);

	const yjsLog = attachYjsLog(ydoc, {
		filePath: yjsPath(options.epicenterRoot, ydoc.guid),
	});

	// From the first attach onward the only handle that tears these resources down
	// is the one we return, so any throw before we return would orphan the SQLite
	// log and (once opened) the relay WebSocket for the daemon's whole life.
	// `ydoc.destroy()` is the single cascade point: the log hooks
	// `ydoc.once('destroy')` and collaboration's `[Symbol.dispose]` is a destroy,
	// so destroying the doc releases whatever attached, even on the branch where
	// `openCollaboration` itself threw and `collaboration` is unset.
	try {
		const collaboration = openCollaboration(ydoc, {
			url: roomWsUrl({
				baseURL: resolveSyncBaseURL(options.baseURL),
				ownerId,
				guid: ydoc.guid,
				nodeId,
			}),
			openWebSocket: auth.openWebSocket,
			onReconnectSignal: auth.onStateChange,
			// The account doc carries no daemon actions; it is the relay floor's
			// connection and a server-owned presence surface, not a dispatch surface.
			actions: {},
		});

		return {
			guid: ydoc.guid,
			ownerId,
			nodeId,
			channelPort: createChannelPort(collaboration.textPort),
			peers: () => collaboration.peers.list(),
			async [Symbol.asyncDispose]() {
				ydoc.destroy();
				await Promise.all([collaboration.whenDisposed, yjsLog.whenDisposed]);
			},
		};
	} catch (cause) {
		ydoc.destroy();
		throw cause;
	}
}
