/**
 * Daemon-side types describing the shape of a hosted daemon runtime.
 *
 * `DaemonRouteDefinition` is the config-time contract: a delayed route starter
 * with its own route name. `DaemonRuntime` is the runtime contract every
 * started daemon route has to satisfy: lifecycle hook, required `actions` root,
 * sync transport, peer directory, and RPC attachments.
 *
 * `StartedDaemonRoute` is one routed runtime the daemon serves internally. The
 * CLI's config loader opens route definitions from the default
 * `{ daemon: { routes } }` export in `epicenter.config.ts`.
 */

import type {
	SyncAttachment,
	SyncRpcAttachment,
} from '../document/attach-sync.js';
import type { PeerDirectory } from '../document/peer-presence.js';
import type { Actions } from '../shared/actions.js';
import type { MaybePromise, ProjectDir } from '../shared/types.js';

export type DaemonRouteContext = {
	projectDir: ProjectDir;
	route: string;
};

/**
 * Fields the daemon looks at on each started runtime.
 */
export type DaemonRuntime = {
	/** Called by the daemon at exit. */
	[Symbol.asyncDispose](): MaybePromise<void>;

	/**
	 * Canonical public action root. Daemon paths are relative to this object:
	 * `workspace.actions.entries.create` is invoked as `<route>.entries.create`.
	 */
	readonly actions: Actions;

	/** Underlying sync transport for bringing the route online. */
	readonly sync: SyncAttachment;
	/** Standard peer directory used by `epicenter peers` and `run --peer`. */
	readonly peerDirectory: PeerDirectory;
	/** Peer RPC transport used by `run --peer`. */
	readonly rpc: SyncRpcAttachment;
};

export type DaemonRouteDefinition<
	TRuntime extends DaemonRuntime = DaemonRuntime,
> = {
	route: string;
	start(options: DaemonRouteContext): MaybePromise<TRuntime>;
};

export type EpicenterConfig = {
	daemon: {
		routes: readonly DaemonRouteDefinition[];
	};
};

export function defineConfig(config: EpicenterConfig): EpicenterConfig {
	return config;
}

/** One routed daemon runtime hosted by the daemon. */
export type StartedDaemonRoute = {
	route: string;
	runtime: DaemonRuntime;
};
