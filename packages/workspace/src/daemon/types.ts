/**
 * Daemon-side runtime types.
 *
 * `DaemonRuntime` is the contract every opened mount returns: async dispose
 * plus the local action registry the daemon serves. Collaborative mounts may
 * also expose a hosted `Collaboration` for identity, sync, and peer presence.
 *
 * `DaemonServedMount` is the narrowed mount-handler contract for the socket
 * app. `StartedMount` is the lifecycle-owning mount shape opened from a
 * configured mount factory.
 */

import type { Collaboration } from '../document/open-collaboration.js';
import type { Peer } from '../document/presence-protocol.js';
import type { PeerTransport } from '../peer-transport.js';
import type { ActionRegistry } from '../shared/actions.js';
import type { MaybePromise } from '../shared/types.js';

/**
 * What the daemon socket app reads to serve `/relay-peers`: this account's other
 * devices currently online on the relay floor (live presence), the dial-target
 * source for `tools`/`call`. A live account room satisfies this structurally; the
 * daemon serves an empty list when there is none (signed out, or the account room
 * failed to open).
 */
export type DaemonServedAccountRoom = {
	peers(): Peer[];
};

/**
 * What the daemon socket app reads to serve `/tools` and `/call`: the dial-side
 * transport of the live device gateway. Absent (signed out, or the gateway
 * failed to open) means cross-device tool routes answer a typed Unavailable.
 */
export type DaemonServedDeviceGateway = {
	transport: PeerTransport;
};

/**
 * Collaboration fields the daemon socket app reads while serving `/peers`: the
 * live peer list for this workspace room.
 */
type DaemonServedCollaboration = {
	peers: {
		list(): Peer[];
	};
};

/**
 * One mounted runtime as served by the daemon socket app.
 *
 * Full started mounts can pass through structurally, but mount handlers do
 * not depend on lifecycle fields such as async disposal.
 */
export type DaemonServedMount = {
	mount: string;
	runtime: {
		actions: ActionRegistry;
		collaboration?: DaemonServedCollaboration;
	};
};

/**
 * Fields the daemon looks at on each started runtime.
 */
export type DaemonRuntime = {
	/** Called by the daemon at exit. */
	[Symbol.asyncDispose](): MaybePromise<void>;

	/**
	 * The action registry this daemon serves locally. When `collaboration` is
	 * present, this must be the same registry handed to `openCollaboration`, so
	 * local runs and the published peer manifest stay in lockstep.
	 */
	readonly actions: ActionRegistry;

	/**
	 * Optional hosted collaboration. Identity, sync status, and live-node
	 * presence live here when the mount participates in a collaborative Yjs
	 * workspace.
	 */
	readonly collaboration?: Collaboration<ActionRegistry>;
};

/** One configured mount runtime hosted by the daemon. */
export type StartedMount = {
	mount: string;
	runtime: DaemonRuntime;
};
