/**
 * Daemon-side types describing the shape of a hosted workspace.
 *
 * `HostedWorkspace` is the public config contract every daemon host has
 * to satisfy: a local `route`, the lifecycle hook, a required `actions`
 * root, plus optional `sync`, `presence`, and `rpc` attachments the daemon
 * reads when present.
 *
 * `WorkspaceEntry` is one routed entry the daemon hosts internally. The CLI's
 * config loader resolves these from the default `defineEpicenterConfig([...])`
 * export in `epicenter.config.ts`.
 */

import type {
	SyncAttachment,
	SyncRpcAttachment,
} from '../document/attach-sync.js';
import type { PeerPresenceAttachment } from '../document/peer-presence.js';
import type { Actions } from '../shared/actions.js';

export const EPICENTER_CONFIG = Symbol.for('epicenter.daemon-config');

/**
 * Fields the daemon looks at on each hosted workspace. `route`, disposal, and
 * `actions` are required. Other fields are read when present. Extra fields are
 * direct-use infrastructure and do not affect daemon action discovery.
 */
export type HostedWorkspace = {
	/**
	 * Local daemon route prefix. `fuji.entries.create` dispatches to the host
	 * whose route is `fuji`, then invokes `entries.create` under `actions`.
	 */
	route: string;

	/** Called by the daemon at exit. */
	[Symbol.dispose](): void;

	/**
	 * Canonical public action root. Daemon paths are relative to this object:
	 * `workspace.actions.entries.create` is invoked as `<route>.entries.create`.
	 */
	readonly actions: Actions;

	/**
	 * Underlying sync transport. Presence and RPC are attached separately so
	 * callers choose which peer surfaces they expose.
	 */
	readonly sync?: SyncAttachment;
	readonly presence?: PeerPresenceAttachment;
	readonly rpc?: SyncRpcAttachment;
	readonly [key: string]: unknown;
};

export type HostedWorkspaceInput = HostedWorkspace | Promise<HostedWorkspace>;

export type EpicenterConfig = {
	readonly [EPICENTER_CONFIG]: true;
	readonly hosts: readonly HostedWorkspaceInput[];
};

export function defineEpicenterConfig(
	hosts: readonly HostedWorkspaceInput[],
): EpicenterConfig {
	return Object.freeze({
		[EPICENTER_CONFIG]: true,
		hosts: Object.freeze([...hosts]),
	});
}

/** One routed workspace hosted by the daemon. */
export type WorkspaceEntry = {
	route: string;
	workspace: HostedWorkspace;
};
