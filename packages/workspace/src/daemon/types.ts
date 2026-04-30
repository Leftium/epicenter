/**
 * Daemon-side types describing the shape of a hosted workspace.
 *
 * `LoadedWorkspace` is the structural contract every workspace export has
 * to satisfy: the `[Symbol.dispose]` discriminator, plus the optional
 * `whenReady`, `sync`, `presence`, and `rpc` fields the daemon reads when
 * present. The workspace's branded actions live as named leaves on the bundle
 * itself (at any depth), not under a fixed `actions` slot: `walkActions(workspace)`
 * discovers them at runtime.
 *
 * `WorkspaceEntry` is one named entry the daemon hosts. The CLI's config
 * loader produces these from `epicenter.config.ts` exports.
 */

import type {
	SyncAttachment,
	SyncRpcAttachment,
} from '../document/attach-sync.js';
import type { PeerPresenceAttachment } from '../document/peer-presence.js';

/**
 * Fields the daemon looks at on each workspace export. Only `[Symbol.dispose]`
 * is required (it's the discriminator); everything else is read when
 * present. Extra fields the factory returns are ignored. `walkActions` and
 * `resolveActionPath` walk the bundle at runtime to find branded leaves.
 */
export type LoadedWorkspace = {
	/**
	 * Called by the daemon at exit. The discriminator: its presence is what
	 * marks the export as a workspace.
	 */
	[Symbol.dispose](): void;

	/** Awaited before any action invocation, if present. */
	readonly whenReady?: Promise<unknown>;

	/**
	 * Underlying sync transport. Presence and RPC are attached separately so
	 * callers choose which peer surfaces they expose.
	 */
	readonly sync?: SyncAttachment;
	readonly actions?: Record<string, unknown>;
	readonly presence?: PeerPresenceAttachment;
	readonly rpc?: SyncRpcAttachment;
};

/** One named workspace export from `epicenter.config.ts`. */
export type WorkspaceEntry = {
	name: string;
	workspace: LoadedWorkspace;
};
