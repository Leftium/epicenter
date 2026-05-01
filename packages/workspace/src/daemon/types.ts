/**
 * Daemon-side types describing the shape of a hosted workspace.
 *
 * `DaemonHostDefinition` is the config-time contract: route metadata plus a
 * delayed `start()` function. `DaemonWorkspace` is the runtime contract every
 * started daemon host has to satisfy: lifecycle hook, required
 * `actions` root, sync transport, peer presence, and RPC attachments.
 *
 * `HostedDaemonWorkspace` is one routed entry the daemon hosts internally. The CLI's
 * config loader opens definitions from the default
 * `defineEpicenterConfig({ hosts })` export in `epicenter.config.ts`.
 */

import type {
	SyncAttachment,
	SyncRpcAttachment,
} from '../document/attach-sync.js';
import type { PeerPresenceAttachment } from '../document/peer-presence.js';
import type { Actions } from '../shared/actions.js';
import type {
	AbsolutePath,
	MaybePromise,
	ProjectDir,
} from '../shared/types.js';

export const EPICENTER_CONFIG = Symbol.for('epicenter.daemon-config');
export const EPICENTER_DAEMON_HOST = Symbol.for('epicenter.daemon-host');

export type EpicenterConfigContext = {
	projectDir: ProjectDir;
	configDir: AbsolutePath;
};

/**
 * Fields the daemon looks at on each started workspace.
 */
export type DaemonWorkspace = {
	/** Called by the daemon at exit. */
	[Symbol.dispose](): void;

	/**
	 * Canonical public action root. Daemon paths are relative to this object:
	 * `workspace.actions.entries.create` is invoked as `<route>.entries.create`.
	 */
	readonly actions: Actions;

	/** Underlying sync transport for bringing the route online. */
	readonly sync: SyncAttachment;
	/** Standard peer presence used by `epicenter peers` and `run --peer`. */
	readonly presence: PeerPresenceAttachment;
	/** Peer RPC transport used by `run --peer`. */
	readonly rpc: SyncRpcAttachment;
};

export type DaemonHostDefinition<
	TWorkspace extends DaemonWorkspace = DaemonWorkspace,
> = {
	[EPICENTER_DAEMON_HOST]: true;
	route: string;
	title?: string;
	description?: string;
	workspaceId?: string;
	start(options: EpicenterConfigContext): MaybePromise<TWorkspace>;
};

export type DefineDaemonOptions<
	TWorkspace extends DaemonWorkspace = DaemonWorkspace,
> = {
	route: string;
	title?: string;
	description?: string;
	workspaceId?: string;
	start(options: EpicenterConfigContext): MaybePromise<TWorkspace>;
};

export function defineDaemon<TWorkspace extends DaemonWorkspace>({
	route,
	title,
	description,
	workspaceId,
	start,
}: DefineDaemonOptions<TWorkspace>): DaemonHostDefinition<TWorkspace> {
	return Object.freeze({
		[EPICENTER_DAEMON_HOST]: true as const,
		route,
		title,
		description,
		workspaceId,
		start,
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
export type HostedDaemonWorkspace = {
	route: string;
	workspace: DaemonWorkspace;
};
