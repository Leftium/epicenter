/**
 * Daemon-side types describing the shape of a hosted daemon runtime.
 *
 * `DaemonHostDefinition` is the config-time contract: route plus a delayed
 * `start()` function. `DaemonRuntime` is the runtime contract every started
 * daemon host has to satisfy: workspace identity, lifecycle hook, required
 * `actions` root, sync transport, peer presence, and RPC attachments.
 *
 * `DaemonRuntimeEntry` is one routed runtime the daemon hosts internally.
 * The CLI's config loader opens definitions from the default
 * `defineEpicenterConfig({ hosts })` export in `epicenter.config.ts`.
 */

import type {
	SyncAttachment,
	SyncRpcAttachment,
} from '../document/attach-sync.js';
import type { PeerPresenceAttachment } from '../document/peer-presence.js';
import type { Actions } from '../shared/actions.js';
import type {
	MaybePromise,
	ProjectDir,
} from '../shared/types.js';

export const EPICENTER_CONFIG = Symbol.for('epicenter.daemon-config');
export const EPICENTER_DAEMON_HOST = Symbol.for('epicenter.daemon-host');

export type EpicenterConfigContext = {
	projectDir: ProjectDir;
};

/**
 * Fields the daemon looks at on each started runtime.
 */
export type DaemonRuntime = {
	/** Called by the daemon at exit. */
	[Symbol.dispose](): void;

	/** Stable workspace identity. Usually the hosted Y.Doc guid. */
	readonly workspaceId: string;

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
	TRuntime extends DaemonRuntime = DaemonRuntime,
> = {
	[EPICENTER_DAEMON_HOST]: true;
	route: string;
	start(options: EpicenterConfigContext): MaybePromise<TRuntime>;
};

export type DefineDaemonOptions<
	TRuntime extends DaemonRuntime = DaemonRuntime,
> = {
	route: string;
	start(options: EpicenterConfigContext): MaybePromise<TRuntime>;
};

export function defineDaemon<TRuntime extends DaemonRuntime>({
	route,
	start,
}: DefineDaemonOptions<TRuntime>): DaemonHostDefinition<TRuntime> {
	return Object.freeze({
		[EPICENTER_DAEMON_HOST]: true as const,
		route,
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

/** One routed daemon runtime hosted by the daemon. */
export type DaemonRuntimeEntry = {
	route: string;
	workspace: DaemonRuntime;
};
