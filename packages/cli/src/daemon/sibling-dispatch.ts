/**
 * Sibling-command auto-detect helpers.
 *
 * `peers`, `list`, and `run` each follow the same dance when a daemon is
 * available for `--dir`: ping, validate workspace inheritance, dispatch
 * the cmd over IPC, render the reply. This module centralizes the dance
 * so the per-command handlers stay focused on argv parsing and rendering.
 *
 * The public surface is intentionally tight:
 *
 *   - {@link resolveTarget} — parse `--dir` / `--workspace` once into a
 *     {@link ResolvedTarget}. Both the daemon probe and the cold-path
 *     loader consume the same object.
 *   - {@link tryGetDaemon} — single dispatch decision: returns a
 *     {@link Daemon} when one is alive and the workspace inherits cleanly,
 *     `'mismatch'` when the user's `--workspace` disagrees with the
 *     daemon (Invariant 7; `process.exitCode` already set), or `null`
 *     when no daemon answers and the caller should fall through.
 *   - {@link renderDaemonResult} — consume an IPC `Result` with one
 *     callback for the success payload; transport errors collapse to
 *     `outputError` + `exitCode=1` here so handlers don't repeat that
 *     block three times.
 *
 * `inheritWorkspace` stays exported for direct testing (Invariant 7
 * coverage in `list-autodetect.test.ts`); it is the only consumer-facing
 * detail of {@link tryGetDaemon}.
 */

import { resolve } from 'node:path';

import type { Result } from 'wellcrafted/result';

import { dirFromArgv, workspaceFromArgv } from '../util/common-options.js';
import { outputError } from '../util/format-output.js';
import { ipcCall, type IpcClientError, ipcPing } from './ipc-client.js';
import type { SerializedError } from './ipc-server.js';
import { readMetadata } from './metadata.js';
import { socketPathFor } from './paths.js';

/**
 * Resolved `--dir` + `--workspace` for a single command invocation.
 *
 * One source of truth: every handler builds this once at the top, then
 * passes it to {@link tryGetDaemon} and to the cold-path config loader.
 * Avoids re-reading `argv` (and re-`resolve`-ing the path) in two places.
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
 * A live daemon endpoint. The handle exposes the inherited workspace
 * (whatever the daemon owns, possibly disagreeing with the absent
 * `--workspace` flag) so commands can include it in their IPC payload
 * without re-reading metadata.
 */
export type Daemon = {
	/** Workspace the daemon owns; may be `undefined` for unnamed entries. */
	workspace: string | undefined;
	/** Issue a single-shot RPC against the daemon. */
	call: <T>(
		cmd: string,
		args: unknown,
	) => Promise<Result<T, IpcClientError | SerializedError>>;
};

/**
 * Outcome of {@link tryGetDaemon}. Three states the caller cares about:
 *
 *   - `Daemon` — dispatch through it.
 *   - `'mismatch'` — workspace inheritance refused; `exitCode=1` is
 *     already set, caller just `return`s.
 *   - `null` — no daemon answers; caller falls through to its in-process
 *     transient path.
 */
export type DaemonLookup = Daemon | 'mismatch' | null;

/**
 * Single dispatch decision for sibling commands. Pings the socket; if a
 * daemon answers, validates `--workspace` against the daemon's owner;
 * returns a {@link Daemon} the caller can `.call(...)` against.
 *
 * Replaces the prior 3-variant dispatch helper: handlers now do
 *
 *     const daemon = await tryGetDaemon(target);
 *     if (daemon === 'mismatch') return;
 *     if (daemon) {
 *       const result = await daemon.call<R>('cmd', { ...ctx, ws: daemon.workspace });
 *       await renderDaemonResult(result, (data) => renderLocal(data));
 *       return;
 *     }
 *     // cold path
 */
export async function tryGetDaemon(
	target: ResolvedTarget,
): Promise<DaemonLookup> {
	const sock = socketPathFor(target.absDir);
	if (!(await ipcPing(sock))) return null;

	const inherited = inheritWorkspace(target.absDir, target.userWorkspace);
	if (!inherited.ok) return 'mismatch';

	return {
		workspace: inherited.workspace,
		call: <T>(cmd: string, args: unknown) => ipcCall<T>(sock, cmd, args),
	};
}

/**
 * Common end-of-IPC rendering. Success flows to `onSuccess`; transport-
 * and handler-level errors collapse to `outputError` + `exitCode=1`.
 *
 * Domain errors that callers want to render distinctly should be carried
 * inside the `T` payload (e.g. {@link ListResult}'s in-band `PeerMiss`),
 * not surfaced as IPC errors — that's why the success callback receives
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
