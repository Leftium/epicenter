/**
 * Daemon-side types describing the shape of a hosted daemon runtime.
 *
 * `DaemonRouteDefinition` is the config-time contract: a delayed route starter
 * with its own route name. `DaemonRuntime` is the runtime contract every
 * started daemon route has to satisfy: async dispose plus the hosted
 * `Collaboration<TActions>` that owns identity, actions, sync, and peers.
 *
 * `StartedDaemonRoute` is one routed runtime the daemon serves internally. The
 * CLI's config loader opens route definitions from the default
 * `{ daemon: { routes } }` export in `epicenter.config.ts`.
 */

import type { Collaboration } from '../document/open-collaboration.js';
import type { ActionRegistry } from '../shared/actions.js';
import type { MaybePromise, ProjectDir } from '../shared/types.js';

export type DaemonRouteContext = {
	projectDir: ProjectDir;
	route: string;
};

/**
 * Fields the daemon looks at on each started runtime.
 */
export type DaemonRuntime<TActions extends ActionRegistry = ActionRegistry> = {
	/** Called by the daemon at exit. */
	[Symbol.asyncDispose](): MaybePromise<void>;

	/**
	 * The hosted collaboration. Identity, action registry, sync status, and
	 * the peers surface for cross-route dispatch all live here.
	 */
	readonly collaboration: Collaboration<TActions>;
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
