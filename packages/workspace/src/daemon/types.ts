/**
 * Daemon-side types describing the shape of a hosted workspace.
 *
 * `DaemonHostDefinition` is the config-time contract: route metadata plus a
 * delayed `open()` function. `HostedWorkspace` is the runtime contract every
 * opened daemon host has to satisfy: a local `route`, lifecycle hook, required
 * `actions` root, plus optional `sync`, `presence`, and `rpc` attachments.
 *
 * `WorkspaceEntry` is one routed entry the daemon hosts internally. The CLI's
 * config loader opens definitions from the default
 * `defineEpicenterConfig({ hosts })` export in `epicenter.config.ts`.
 */

import type { MaybePromise } from '../shared/types.js';
import type { AbsolutePath, ProjectDir } from '../shared/types.js';
import type {
	SyncAttachment,
	SyncRpcAttachment,
} from '../document/attach-sync.js';
import type { PeerPresenceAttachment } from '../document/peer-presence.js';
import type { Actions } from '../shared/actions.js';

export const EPICENTER_CONFIG = Symbol.for('epicenter.daemon-config');
export const EPICENTER_DAEMON_HOST = Symbol.for('epicenter.daemon-host');

export type EpicenterConfigContext = {
	projectDir: ProjectDir;
	configDir: AbsolutePath;
};

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

export type DaemonHostDefinition = {
	[EPICENTER_DAEMON_HOST]: true;
	route: string;
	title?: string;
	description?: string;
	workspaceId?: string;
	open(options: EpicenterConfigContext): MaybePromise<HostedWorkspace>;
};

export type DefineDaemonOptions = {
	route: string;
	title?: string;
	description?: string;
	workspaceId?: string;
	open(options: EpicenterConfigContext): MaybePromise<HostedWorkspace>;
};

export function defineDaemon({
	route,
	title,
	description,
	workspaceId,
	open,
}: DefineDaemonOptions): DaemonHostDefinition {
	return Object.freeze({
		[EPICENTER_DAEMON_HOST]: true as const,
		route,
		title,
		description,
		workspaceId,
		open,
	});
}

export type EpicenterConfig = {
	[EPICENTER_CONFIG]: true;
	hosts: readonly DaemonHostDefinition[];
};

export type DefineEpicenterConfigOptions = {
	hosts: readonly DaemonHostDefinition[];
};

export function defineEpicenterConfig({
	hosts,
}: DefineEpicenterConfigOptions): EpicenterConfig {
	return Object.freeze({
		[EPICENTER_CONFIG]: true as const,
		hosts: Object.freeze([...hosts]),
	});
}

/** One routed workspace hosted by the daemon. */
export type WorkspaceEntry = {
	route: string;
	workspace: HostedWorkspace;
};
