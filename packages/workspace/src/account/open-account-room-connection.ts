/**
 * Open the per-person account room as a relay-floor connection. Browser-safe.
 *
 * The account room is the per-user fleet room: an ordinary sync room at the
 * reserved guid {@link RESERVED_ACCOUNT_ROOM_GUID}, so every device a person
 * runs (the daemon, a browser tab) joins the SAME room and can route typed
 * channels to one another over the one socket each already holds. This is the
 * relay floor's home, and it is what makes a cross-device tool call reachable:
 * the channel router (`packages/server/src/room/channel-router.ts`) forwards a
 * channel only among sockets in one room, so the caller and the target must both
 * be in this account room, not in some workspace's vault-doc room.
 *
 * This module is the browser-safe core that both ends share: the daemon's
 * {@link ../daemon/open-account-room.openAccountRoom} resolves node-only config
 * (the durable node id off disk, the daemon's sync base URL) and the
 * `clientId` it pins, then delegates here; a browser passes `{ ...signedIn,
 * nodeId }` straight in. Keeping one definition of "what an account-room
 * connection is" is why this is extracted rather than forked.
 *
 * It pulls no node builtin: `openCollaboration`, `roomWsUrl`, and
 * `createChannelPort` are all browser-safe, and the deterministic Y.Doc
 * `clientID` (the one node-only piece, hashed with `node:crypto`) is passed in
 * as an optional number rather than computed here.
 */

import type { OwnerId } from '@epicenter/identity';
import * as Y from 'yjs';
import type { NodeId } from '../document/node-id.js';
import {
	type OnReconnectSignal,
	type OpenWebSocketFn,
	openCollaboration,
} from '../document/open-collaboration.js';
import type { Peer } from '../document/presence-protocol.js';
import { roomWsUrl } from '../document/transport.js';
import { type ChannelPort, createChannelPort } from '../relay-channel/index.js';
import { RESERVED_ACCOUNT_ROOM_GUID } from './reserved-guid.js';

/**
 * Coordinates to reach the account room over the relay. A structural subset of
 * the {@link ../document/connect-doc.ConnectionConfig} a workspace doc uses
 * (the account room attaches no local storage, so `server` is not needed), so a
 * browser passes `{ ...signedIn, nodeId }` here directly.
 */
export type AccountRoomConnectionConfig = {
	/** This device's durable relay routing id and dial target. */
	nodeId: NodeId;
	/** The signed-in account owner; selects the partitioned room URL path. */
	ownerId: OwnerId;
	/** Full API origin URL (e.g. `https://api.epicenter.so`); upgrades to `wss://`. */
	baseURL: string;
	/** Bearer-attached WebSocket opener (`auth.openWebSocket`). */
	openWebSocket: OpenWebSocketFn;
	/** Auth state-change publication; sync reconnects after token refreshes. */
	onReconnectSignal: OnReconnectSignal;
	/**
	 * Optional deterministic Y.Doc CRDT `clientID`. The daemon pins one
	 * (`hashYDocClientId`, node-only) so its writes merge under a stable identity
	 * across restarts; a browser omits it. The account doc carries no data of its
	 * own (presence is server-owned, the channel port rides text frames), so a
	 * random per-session clientID is harmless, and omitting it keeps this core
	 * free of `node:crypto`.
	 */
	clientId?: number;
	/**
	 * The relay-exposed (MCP) route names this device serves, advertised in
	 * account-room presence so the user's other devices auto-mount them as tool
	 * catalogs (floor discovery). The daemon passes its opened routes; a browser is
	 * a pure consumer and omits it.
	 */
	exposedRoutes?: string[];
};

/**
 * A live account-room connection: the relay floor over one socket. `peers()`
 * reads the user's other online devices; `channelPort` carries cross-device tool
 * channels; `[Symbol.asyncDispose]` destroys the doc and drains its sync
 * connection.
 */
export type AccountRoomConnection = {
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
	 * relay-channel transport and acceptor ride. It carries channels to and from
	 * this user's other devices over the connection already held, no second socket.
	 */
	channelPort: ChannelPort;
	/**
	 * This account's other devices currently connected to the relay floor, from the
	 * server's live presence (newest-wins per nodeId, self excluded). You reach a
	 * device that is online, addressed by its nodeId, with no enrollment in between.
	 */
	peers(): Peer[];
	/**
	 * Subscribe to presence changes: `fn` runs with the new list each time a device
	 * comes online or drops. Returns an unsubscribe. A picker UI drives a live
	 * device list off this rather than polling {@link peers}.
	 */
	onPeersChange(fn: (peers: Peer[]) => void): () => void;
	[Symbol.asyncDispose](): Promise<void>;
};

/**
 * Open the account room and return a handle. Synchronous: `openCollaboration`
 * wires the socket for its side effect; the caller awaits `peers()` settling or
 * a channel opening, not this call.
 */
export function openAccountRoomConnection(
	config: AccountRoomConnectionConfig,
): AccountRoomConnection {
	const {
		nodeId,
		ownerId,
		baseURL,
		openWebSocket,
		onReconnectSignal,
		clientId,
		exposedRoutes,
	} = config;

	const ydoc = new Y.Doc({ guid: RESERVED_ACCOUNT_ROOM_GUID });
	// Pin a deterministic clientID before any local edit when the caller supplies
	// one, so that device's writes merge under one stable CRDT identity across
	// restarts. A browser omits it (see the config doc).
	if (clientId !== undefined) ydoc.clientID = clientId;

	// The account doc carries no data of its own, so it attaches no durable log;
	// the Y.Doc exists only because `openCollaboration` syncs through one. The only
	// handle that tears the connection down is the one we return, so a throw before
	// we return would orphan the relay WebSocket. `ydoc.destroy()` is the single
	// cascade point: collaboration's `[Symbol.dispose]` is hooked to the doc's
	// destroy, so destroying the doc releases it even on the branch where
	// `openCollaboration` itself threw and `collaboration` is unset.
	try {
		const collaboration = openCollaboration(ydoc, {
			url: roomWsUrl({
				baseURL,
				ownerId,
				guid: ydoc.guid,
				nodeId,
			}),
			openWebSocket,
			onReconnectSignal,
			// The account doc carries no actions; it is the relay floor's connection
			// and a server-owned presence surface, not a dispatch surface.
			actions: {},
			// Advertise this device's relay-exposed routes so the user's other
			// devices can auto-mount them as tool catalogs. A browser passes nothing
			// here.
			...(exposedRoutes !== undefined && { exposedRoutes }),
		});

		return {
			guid: ydoc.guid,
			ownerId,
			nodeId,
			channelPort: createChannelPort(collaboration.textPort),
			peers: () => collaboration.peers.list(),
			onPeersChange: (fn) => collaboration.peers.subscribe(fn),
			async [Symbol.asyncDispose]() {
				ydoc.destroy();
				await collaboration.whenDisposed;
			},
		};
	} catch (cause) {
		ydoc.destroy();
		throw cause;
	}
}
