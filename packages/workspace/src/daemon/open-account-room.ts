/**
 * Open the per-person account room on the daemon (Wave 3: discovery / roster).
 *
 * The account doc is the per-person device roster and (from Wave 4) trust
 * ledger. It is NOT a new Durable Object: it is an ordinary sync room at the
 * reserved guid {@link RESERVED_ACCOUNT_ROOM_GUID}, so it reuses every bit of
 * room machinery (bearer auth, Y.Doc sync, the WebSocket upgrade) the same way a
 * mount's room does. `epicenter daemon up` opens it alongside its mount.
 *
 * What this node module owns is exactly the node-only glue the browser-safe
 * `account/` core cannot do: load the device's durable iroh secret from its
 * `0600` keyfile, persist the doc's update log to disk, join the room over the
 * relay, and append the device's self-signed `identity` claim with the
 * machine's hostname as its label. The signing and the roster fold themselves
 * are the portable `account/` code; this module hands it raw key bytes and a
 * `Y.Doc`, never iroh, so the trust path stays browser-verifiable.
 *
 * It is gated on a signed-in session: the room is bearer-authed, so a signed-out
 * daemon has no account room (it returns `null`, the room's analogue of an
 * inactive mount). The daemon treats opening it as best-effort: a failure here
 * never aborts the mount that is the daemon's actual job.
 */

import { hostname } from 'node:os';
import * as Y from 'yjs';

import {
	appendIdentityClaim,
	readRoster,
	RESERVED_ACCOUNT_ROOM_GUID,
	type Roster,
} from '../account/index.js';
import type { WorkspaceAuthClient } from '../config/open-epicenter-root.js';
import { attachYjsLog } from '../document/attach-yjs-log.js';
import { asNodeId } from '../document/node-id.js';
import { openCollaboration } from '../document/open-collaboration.js';
import { roomWsUrl } from '../document/transport.js';
import { yjsPath } from '../document/workspace-paths.js';
import { loadOrCreateDeviceSecret } from '../gateway/key-store.js';
import { hashYDocClientId } from '../shared/client-id.js';
import { irohKeyPathFor } from './paths.js';
import { resolveSyncBaseURL } from './mount-runtime.js';

/** Inputs to {@link openAccountRoom}. */
export type OpenAccountRoomOptions = {
	/** The Epicenter root whose daemon is opening the room (selects the keyfile). */
	epicenterRoot: string;
	/**
	 * The machine auth client, or `null` when signed out. The room is opened only
	 * for a signed-in session; a signed-out daemon gets `null` back.
	 */
	auth: WorkspaceAuthClient | null;
	/** Explicit sync base URL; falls back through {@link resolveSyncBaseURL}. */
	baseURL?: string;
	/**
	 * The device label to publish. Defaults to the machine hostname; injectable
	 * so tests pin a deterministic value. A user-facing rename surface can pass a
	 * stored override here in a later wave.
	 */
	label?: string;
};

/**
 * A live account-room connection. `roster()` reads the current device roster
 * (the reducer's fold of the signed log); `[Symbol.asyncDispose]` tears the
 * doc, sync, and durable log down in the same destroy-then-drain order a mount
 * uses.
 */
export type AccountRoomHandle = {
	/** The reserved guid this room was opened at. */
	guid: string;
	/** This device's peerId (its iroh public key, 64-hex). */
	peerId: string;
	/** The current device roster: every dialable peer this account has listed. */
	roster(): Roster;
	[Symbol.asyncDispose](): Promise<void>;
};

/**
 * Open the account room for the signed-in user, append this device's identity
 * claim, and return a handle. Returns `null` when machine auth is absent or
 * signed out (a valid state, like an inactive mount): there is no account room
 * without a bearer to auth the room socket.
 */
export async function openAccountRoom(
	options: OpenAccountRoomOptions,
): Promise<AccountRoomHandle | null> {
	const { auth } = options;
	if (auth === null || auth.state.status === 'signed-out') return null;
	const { ownerId } = auth.state;

	// The device's durable iroh key is both its identity and its signing key
	// (ADR-0073). Load it once; its public key is the nodeId the relay routes by
	// and the peerId the roster lists, and its raw bytes sign the identity claim.
	const secret = loadOrCreateDeviceSecret(irohKeyPathFor(options.epicenterRoot));
	const secretKeyBytes = Uint8Array.from(secret.toBytes());
	const nodeId = asNodeId(secret.public().toString());

	const ydoc = new Y.Doc({ guid: RESERVED_ACCOUNT_ROOM_GUID });
	// Pin a deterministic clientID before any local edit, so each device's writes
	// merge under one stable CRDT identity across restarts.
	ydoc.clientID = hashYDocClientId(nodeId);

	const yjsLog = attachYjsLog(ydoc, {
		filePath: yjsPath(options.epicenterRoot, ydoc.guid),
	});

	const collaboration = openCollaboration(ydoc, {
		url: roomWsUrl({
			baseURL: resolveSyncBaseURL(options.baseURL),
			ownerId,
			guid: ydoc.guid,
			nodeId,
		}),
		openWebSocket: auth.openWebSocket,
		onReconnectSignal: auth.onStateChange,
		// The account doc carries no daemon actions; it is a synced log, not a
		// dispatch surface.
		actions: {},
	});

	// Announce this device. The local log is already hydrated (attachYjsLog is
	// synchronous) and every identity claim about this peer is signed by this
	// device alone, so the append is correct against local state without waiting
	// on the first cloud sync; it is idempotent on the label across restarts.
	const { peerId } = appendIdentityClaim({
		ydoc,
		account: ownerId,
		secretKeyBytes,
		label: options.label ?? hostname(),
	});

	return {
		guid: ydoc.guid,
		peerId,
		roster: () => readRoster(ydoc, ownerId),
		async [Symbol.asyncDispose]() {
			ydoc.destroy();
			await Promise.all([collaboration.whenDisposed, yjsLog.whenDisposed]);
		},
	};
}
