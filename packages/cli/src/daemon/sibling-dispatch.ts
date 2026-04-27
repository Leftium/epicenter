/**
 * Sibling-command attach helpers.
 *
 * `peers`, `list`, and `run` each have two execution modes: **standalone**
 * (load the workspace in-process, do the work, exit) and **attached**
 * (the daemon already has the workspace warm; route the request through
 * the IPC socket).
 *
 * The dispatch surface is intentionally tiny:
 *
 *   - {@link resolveTarget}: parse `--dir` / `--workspace` once into a
 *     {@link ResolvedTarget}. Both the daemon probe and the cold-path
 *     loader consume the same object.
 *   - {@link tryGetDaemon}: single dispatch decision. Returns a
 *     {@link DaemonClient} when one is alive, or `null` to fall through
 *     to the in-process path. There is no "mismatch" state: the daemon
 *     serves every workspace its config exports (Invariant 7), and an
 *     unknown `--workspace` surfaces from the daemon's own
 *     `resolveEntry` lookup as a normal IPC error (same phrasing the
 *     cold path would emit).
 *   - {@link renderDaemonResult}: consume an IPC `Result` with one
 *     callback for the success payload. Transport errors collapse to
 *     `outputError` + `exitCode=1` here so handlers don't repeat that
 *     block three times.
 */

import { resolve } from 'node:path';

import type { Result } from 'wellcrafted/result';

import { dirFromArgv, workspaceFromArgv } from '../util/common-options.js';
import { outputError } from '../util/format-output.js';
import {
	type DaemonClient,
	daemonClient,
	type IpcClientError,
	ipcPing,
} from './ipc-client.js';
import type { SerializedError } from './ipc-server.js';
import { socketPathFor } from './paths.js';

export type { DaemonClient } from './ipc-client.js';

/**
 * Resolved `--dir` + `--workspace` for a single command invocation.
 * One source of truth: every handler builds this once at the top, then
 * passes it to {@link tryGetDaemon} and to the cold-path config loader.
 */
export type ResolvedTarget = {
	absDir: string;
	userWorkspace: string | undefined;
};

export function resolveTarget(args: Record<string, unknown>): ResolvedTarget {
	return {
		absDir: resolve(dirFromArgv(args)),
		userWorkspace: workspaceFromArgv(args),
	};
}

/**
 * Single dispatch decision for sibling commands. Pings the socket; if a
 * daemon answers, returns a typed {@link DaemonClient} the caller can
 * dispatch route methods on. If no daemon is alive, returns `null` and
 * the caller falls through to its in-process transient path.
 */
export async function tryGetDaemon(
	target: ResolvedTarget,
): Promise<DaemonClient | null> {
	const sock = socketPathFor(target.absDir);
	if (!(await ipcPing(sock))) return null;
	return daemonClient(sock);
}

/**
 * Common end-of-IPC rendering. Success flows to `onSuccess`; transport-
 * and handler-level errors collapse to `outputError` + `exitCode=1`.
 *
 * Domain errors that callers want to render distinctly should be carried
 * inside the `T` payload (e.g. {@link ListResult}'s in-band `PeerMiss`),
 * not surfaced as IPC errors. That's why the success callback receives
 * the raw `data` rather than a `Result`.
 */
export async function renderDaemonResult<T>(
	result: Result<T, IpcClientError | SerializedError>,
	onSuccess: (data: T) => void | Promise<void>,
): Promise<void> {
	if (result.error === null) {
		await onSuccess(result.data);
		return;
	}
	outputError(`error: ${result.error.message}`);
	process.exitCode = 1;
}
