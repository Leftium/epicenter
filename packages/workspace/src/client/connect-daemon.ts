/**
 * `connectDaemon`: front door for talking to actions hosted by a running
 * daemon. The single entry point shared by vault scripts and every CLI
 * command that dispatches a workspace action.
 *
 * Generic `TWorkspace` is the in-process workspace shape (typically
 * `ReturnType<typeof openFuji>`); the runtime returns a
 * `DaemonActions<TWorkspace>` proxy backed by a unix-socket `DaemonClient`.
 * `TWorkspace` is type-only: no workspace code runs in the caller process.
 * `DaemonActions<TWorkspace>` filters it to branded `defineQuery` /
 * `defineMutation` leaves and rewrites each into the daemon `/run` result.
 *
 * @example
 * ```ts
 * import { connectDaemon } from '@epicenter/workspace';
 * import type { openFuji } from '@epicenter/fuji/workspace';
 *
 * using fuji = await connectDaemon<ReturnType<typeof openFuji>>({
 *   id: 'fuji',
 * });
 * await fuji.actions.entries.update({ id, tags: ['untagged'] });
 * ```
 *
 * Daemon-scope calls (peers, list across workspaces) live on `DaemonClient`
 * directly: construct one with `daemonClient(socketPathFor(projectDir))` and
 * call `.peers()` / `.list()` against the same socket. They are not
 * reachable through this workspace handle.
 */

import type { ProjectDir } from '../shared/types.js';
import { getDaemon } from '../daemon/client.js';
import { findEpicenterDir } from './find-epicenter-dir.js';
import { buildDaemonActions } from './daemon-actions.js';
import type { DaemonActions } from './daemon-action-types.js';

/**
 * Connect to a workspace's public actions hosted by a running daemon.
 *
 * `id` is the workspace selector. Today the wire dispatches by the
 * human-facing `name` exported in `epicenter.config.ts` (per Phase 2's
 * pragmatic deviation); long-term this collapses to `ydoc.guid`. Either
 * way, the value is opaque to this function and threads through to the remote
 * daemon action proxy.
 *
 * `projectDir` defaults to walking up from `process.cwd()` for an
 * `epicenter.config.ts` file or a `.epicenter/` directory.
 *
 * Throws `DaemonError.MissingConfig` when the project has no config, or
 * `DaemonError.Required` when no daemon is listening on the resolved socket.
 * Start one with `epicenter up`. There is no auto-spawn: explicit lifecycle
 * is the contract.
 */
export async function connectDaemon<TWorkspace>({
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
}): Promise<DaemonActions<TWorkspace>> {
	const { data: client, error } = await getDaemon(projectDir);
	if (error) throw error;
	return buildDaemonActions<TWorkspace>(client, id);
}
