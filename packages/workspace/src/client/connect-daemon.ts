/**
 * `connectDaemon`: front door for talking to actions hosted by a running
 * daemon. The single entry point shared by vault scripts and every CLI
 * command that dispatches a workspace action.
 *
 * Generic `TActions` is the in-process `workspace.actions` shape (typically
 * `ReturnType<typeof openFuji>['actions']`); the runtime returns a
 * `RemoteActions<TActions>` proxy backed by a unix-socket `DaemonClient`.
 * `TActions` is type-only: no workspace code runs in the caller process.
 * `RemoteActions<TActions>` filters it to branded `defineQuery` /
 * `defineMutation` leaves and rewrites each into `Promise<Result<_, _ |
 * RpcError>>`.
 *
 * @example
 * ```ts
 * import { connectDaemon } from '@epicenter/workspace';
 * import type { openFuji } from '@epicenter/fuji/workspace';
 *
 * using fujiActions = await connectDaemon<ReturnType<typeof openFuji>['actions']>({
 *   id: 'fuji',
 * });
 * await fujiActions.entries.update({ id, tags: ['untagged'] });
 * ```
 *
 * Daemon-scope calls (peers, list across workspaces) live on `DaemonClient`
 * directly: construct one with `daemonClient(socketPathFor(projectDir))` and
 * call `.peers()` / `.list()` against the same socket. They are not
 * reachable through this workspace handle.
 */

import type { ProjectDir } from '../shared/types.js';
import { DaemonError, daemonClient, pingDaemon } from '../daemon/client.js';
import { socketPathFor } from '../daemon/paths.js';
import { findEpicenterDir } from './find-epicenter-dir.js';
import { buildRemoteActions } from './remote-actions.js';
import type { RemoteActions } from './remote-action-types.js';

/**
 * Connect to a workspace's public action registry hosted by a running daemon.
 *
 * `id` is the workspace selector. Today the wire dispatches by the
 * human-facing `name` exported in `epicenter.config.ts` (per Phase 2's
 * pragmatic deviation); long-term this collapses to `ydoc.guid`. Either
 * way, the value is opaque to this function and threads through to the remote
 * action proxy.
 *
 * `projectDir` defaults to walking up from `process.cwd()` for an
 * `epicenter.config.ts` file or a `.epicenter/` directory.
 *
 * Throws `DaemonError.Required` if no daemon is listening on the
 * resolved socket. Start one with `epicenter up`. There is no
 * auto-spawn: explicit lifecycle is the contract.
 */
export async function connectDaemon<TActions>({
	id,
	projectDir = findEpicenterDir(),
}: {
	id: string;
	/**
	 * Project root. Defaults to the nearest ancestor of `process.cwd()`
	 * containing `epicenter.config.ts` or `.epicenter/`. Throws via
	 * `findEpicenterDir` if no such ancestor exists; pass an explicit
	 * `projectDir` to opt out.
	 */
	projectDir?: ProjectDir;
}): Promise<RemoteActions<TActions>> {
	const socketPath = socketPathFor(projectDir);
	if (!(await pingDaemon(socketPath))) {
		throw DaemonError.Required({ projectDir }).error;
	}
	const client = daemonClient(socketPath);
	return buildRemoteActions<TActions>(client, id);
}
