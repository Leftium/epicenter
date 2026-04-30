/**
 * `buildRemoteActions`: typed proxy that turns a `DaemonClient` into an
 * action-registry-shaped facade. Local call sites use the same dotted path
 * they would under `workspace.actions` (`savedTabs.create(...)`); each call
 * dispatches over the unix socket via `client.run`.
 *
 * The proxy is a single recursive `Proxy` rooted at the action registry.
 * Property access walks the chain and accumulates path segments; calling
 * the resulting proxy invokes `client.run` with the joined dotted path.
 *
 * `then` is masked at every level so an accidental `await actions.tabs` does
 * not turn an intermediate namespace into a thenable and pollute the path
 * with a stray `.then` segment.
 */

import type { DaemonClient } from '../daemon/client.js';
import type { RemoteActions } from './remote-action-types.js';

const DEFAULT_RPC_TIMEOUT_MS = 5_000;

/**
 * Recursive proxy rooted at the action registry. Property access produces another
 * proxy carrying the path-so-far; calling the proxy dispatches `client.run`
 * with the joined dotted path.
 *
 * `function () {}` is the proxy target so `apply` is reachable. The `then`
 * key is masked everywhere on the path (otherwise an `await` on an
 * intermediate namespace would turn it into a thenable).
 */
function buildRemoteActionProxy(
	client: DaemonClient,
	workspaceName: string,
): unknown {
	const make = (path: string[]): unknown => {
		const target = (() => {}) as unknown as object;
		return new Proxy(target, {
			get(_target, prop) {
				if (typeof prop !== 'string') return undefined;
				if (prop === 'then') return undefined;
				return make([...path, prop]);
			},
			apply(_target, _thisArg, args) {
				const input = args.length === 0 ? undefined : args[0];
				return client.run({
					actionPath: `${workspaceName}.${path.join('.')}`,
					input,
					waitMs: DEFAULT_RPC_TIMEOUT_MS,
				});
			},
		});
	};
	return make([]);
}

/**
 * Compose the remote action registry facade. Generic `TActions` is the
 * in-process `workspace.actions` shape; `RemoteActions<TActions>` filters it
 * to branded leaves only and rewrites each leaf to
 * `Promise<Result<_, _ | RpcError>>`.
 */
export function buildRemoteActions<TActions>(
	client: DaemonClient,
	workspaceName: string,
): RemoteActions<TActions> {
	return buildRemoteActionProxy(client, workspaceName) as RemoteActions<TActions>;
}
