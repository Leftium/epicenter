/**
 * Daemon-side types describing the shape of a hosted daemon runtime.
 *
 * `DaemonRouteModule` is the config-time contract: a delayed function keyed by
 * route name. `DaemonRuntime` is the runtime contract every started daemon
 * route has to satisfy: workspace identity, lifecycle hook, required `actions`
 * root, sync transport, peer presence, and RPC attachments.
 *
 * `DaemonRuntimeEntry` is one routed runtime the daemon serves internally. The
 * CLI's config loader opens route modules from the default
 * `defineEpicenterConfig({ daemon: { routes } })` export in `epicenter.config.ts`.
 */

import type {
	SyncAttachment,
	SyncRpcAttachment,
} from '../document/attach-sync.js';
import type { PeerPresenceAttachment } from '../document/peer-presence.js';
import type { Actions } from '../shared/actions.js';
import type { MaybePromise, ProjectDir } from '../shared/types.js';

export const EPICENTER_CONFIG = Symbol.for('epicenter.daemon-config');

export type EpicenterConfigContext = {
	projectDir: ProjectDir;
	route: string;
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

export type DaemonRouteModule<TRuntime extends DaemonRuntime = DaemonRuntime> =
	(options: EpicenterConfigContext) => MaybePromise<TRuntime>;

export type EpicenterConfig = {
	[EPICENTER_CONFIG]: true;
	daemon: {
		routes: Readonly<Record<string, DaemonRouteModule>>;
	};
};

export type DefineEpicenterConfigOptions = {
	daemon: {
		routes: Record<string, DaemonRouteModule>;
	};
};

export function defineEpicenterConfig({
	daemon,
}: DefineEpicenterConfigOptions): EpicenterConfig {
	return Object.freeze({
		[EPICENTER_CONFIG]: true as const,
		daemon: Object.freeze({
			routes: Object.freeze({ ...daemon.routes }),
		}),
	});
}

/** One routed daemon runtime hosted by the daemon. */
export type DaemonRuntimeEntry = {
	route: string;
	workspace: DaemonRuntime;
};
