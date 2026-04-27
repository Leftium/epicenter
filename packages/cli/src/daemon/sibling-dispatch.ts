/**
 * Sibling-command auto-detect helpers.
 *
 * `peers`, `list`, and `run` each follow the same dance when a daemon is
 * available for `--dir`: ping, validate workspace inheritance, dispatch
 * the cmd over IPC, render the reply. This module centralizes the dance
 * so the per-command handlers stay focused on argv parsing and rendering.
 *
 * `inheritWorkspace` is the Invariant-7 enforcement (a sibling whose
 * `--workspace` disagrees with the daemon's owner errors instead of
 * silently dispatching to the wrong entry). It used to live in `list.ts`,
 * which forced `run.ts` and `peers.ts` to import sibling-to-sibling; the
 * helper belongs here next to its only consumers.
 */

import { resolve } from 'node:path';

import type { Result } from 'wellcrafted/result';

import { dirFromArgv } from '../util/common-options.js';
import { outputError } from '../util/format-output.js';
import { ipcCall, type IpcClientError, ipcPing } from './ipc-client.js';
import type { SerializedError } from './ipc-server.js';
import { readMetadata } from './metadata.js';
import { socketPathFor } from './paths.js';

/**
 * Resolve which workspace the sibling should target when a daemon is
 * running. The daemon owns one entry; a user passing a conflicting
 * `--workspace` should fail loudly rather than dispatch to the wrong one.
 *
 * Side effects: emits the spec's literal mismatch message and sets
 * `process.exitCode = 1` on the failure branch.
 *
 * Returns:
 *   - `{ ok: true, workspace }` — pass `workspace` along to the IPC call.
 *     `workspace` is the daemon's owner if the user omitted the flag;
 *     otherwise the user's value (which we've already verified matches).
 *   - `{ ok: false }` — caller bails; exitCode is already set.
 */
export type Inherited =
	| { ok: true; workspace: string | undefined }
	| { ok: false };

export function inheritWorkspace(
	absDir: string,
	userWorkspace: string | undefined,
): Inherited {
	const meta = readMetadata(absDir);
	// Daemon raced away between ping and inherit — fall back to user's value.
	if (!meta) return { ok: true, workspace: userWorkspace };
	if (userWorkspace === undefined) return { ok: true, workspace: meta.workspace };
	if (userWorkspace !== meta.workspace) {
		outputError(
			`workspace mismatch: daemon owns '${meta.workspace}', requested '${userWorkspace}' — restart the daemon or omit --workspace`,
		);
		process.exitCode = 1;
		return { ok: false };
	}
	return { ok: true, workspace: userWorkspace };
}

/**
 * Outcome of {@link tryDaemonDispatch}. Three states:
 *
 *   - `'no-daemon'`: the socket didn't ping. Caller falls back to its
 *     transient in-process path.
 *   - `'mismatch'`: workspace inheritance refused. `exitCode` is already
 *     set; caller just returns.
 *   - `'dispatched'`: the IPC call completed. The caller's renderer
 *     consumes `result` exactly the way it consumes the in-process
 *     `result` from `listCore` / `runCore`.
 */
export type DispatchOutcome<T> =
	| { kind: 'no-daemon' }
	| { kind: 'mismatch' }
	| { kind: 'dispatched'; result: Result<T, IpcClientError | SerializedError> };

/**
 * Auto-detect path shared by `peers`, `list`, and `run`. Pings the socket
 * for `--dir`; if a daemon answers, validates `--workspace` against the
 * daemon's owner via {@link inheritWorkspace}, then forwards `cmd` with
 * the (possibly inherited) workspace name.
 *
 * `buildArgs(workspace)` lets each command shape its IPC payload — `list`
 * builds a `ListCtx`, `run` builds a `RunCtx`, `peers` ships a `{wait}`
 * object. Whatever shape they pass is what arrives in `req.args` on the
 * daemon side.
 */
export async function tryDaemonDispatch<T>(
	args: Record<string, unknown>,
	userWorkspace: string | undefined,
	cmd: string,
	buildArgs: (workspace: string | undefined) => unknown,
): Promise<DispatchOutcome<T>> {
	const absDir = resolve(dirFromArgv(args));
	const sock = socketPathFor(absDir);
	if (!(await ipcPing(sock))) return { kind: 'no-daemon' };

	const inherited = inheritWorkspace(absDir, userWorkspace);
	if (!inherited.ok) return { kind: 'mismatch' };

	const result = await ipcCall<T>(sock, cmd, buildArgs(inherited.workspace));
	return { kind: 'dispatched', result };
}
