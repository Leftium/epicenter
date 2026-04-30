/**
 * Daemon-side types describing the shape of a hosted workspace.
 *
 * `LoadedWorkspace` is the structural contract every workspace export has
 * to satisfy: the `[Symbol.dispose]` discriminator, a required `actions`
 * root, plus the optional `whenReady`, `sync`, `presence`, and `rpc` fields
 * the daemon reads when present.
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
 * Fields the daemon looks at on each workspace export. `[Symbol.dispose]` and
 * `actions` are required. Other fields are read when present. Extra fields are
 * direct-use infrastructure and do not affect daemon action discovery.
 */
export type LoadedWorkspace = {
	/**
	 * Called by the daemon at exit. The discriminator: its presence is what
	 * marks the export as a workspace.
	 */
	[Symbol.dispose](): void;

	/**
	 * Canonical public action root. Daemon paths are relative to this object:
	 * `workspace.actions.entries.create` is invoked as `<export>.entries.create`.
	 */
	readonly actions: Record<string, unknown>;

	/** Awaited before any action invocation, if present. */
	readonly whenReady?: Promise<unknown>;

	/**
	 * Underlying sync transport. Presence and RPC are attached separately so
	 * callers choose which peer surfaces they expose.
	 */
	readonly sync?: SyncAttachment;
	readonly presence?: PeerPresenceAttachment;
	readonly rpc?: SyncRpcAttachment;
	readonly [key: string]: unknown;
};

/** One named workspace export from `epicenter.config.ts`. */
export type WorkspaceEntry = {
	name: string;
	workspace: LoadedWorkspace;
};
