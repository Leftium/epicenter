/**
 * `epicenter run <dot.path> [input]`: invoke a `defineQuery` /
 * `defineMutation` by dot-path through a loaded workspace.
 *
 * `input` is JSON: inline positional, `@file.json` (curl convention), or stdin.
 * With `--peer <target>`, the invocation is dispatched over the sync
 * room's RPC channel to a remote peer instead of running locally.
 *
 * Exit codes:
 *   1: usage error (unknown action, workspace miss, missing sync for `--peer`)
 *   2: runtime error (local action returned Err, or remote RPC failed)
 *   3: peer-miss (`--peer <target>` didn't resolve within `--wait`)
 *
 * ## Two execution modes
 *
 * - **Standalone** (default): the handler loads the workspace in-process,
 *   calls {@link runCore}, renders, and exits.
 * - **Attached** (when an `epicenter up` daemon is running for the same
 *   `--dir`): the handler dispatches over IPC and the daemon runs
 *   {@link runCore} against its already-open workspace.
 *
 * Both paths produce a {@link RunResult} of the same shape, so the
 * renderer doesn't branch on which side built it.
 */

import {
	type Action,
	invokeAction,
	resolveActionPath,
	type RpcError,
	walkActions,
} from '@epicenter/workspace';
import type { AwarenessState } from '../load-config';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import type { Argv, CommandModule, Options } from 'yargs';
import { type DaemonError, tryGetDaemon } from '../daemon/client';
import type { RunCtx } from '../daemon/schemas';
import { loadConfig, type WorkspaceEntry } from '../load-config';
import { dirOption, resolveTarget, workspaceOption } from '../util/common-options';
import {
	formatYargsOptions,
	output,
	outputError,
} from '../util/format-output';
import { parseJsonInput, readStdin } from '../util/parse-input';
import { explainEmpty, waitForPeer } from '../util/peer-wait';
import { resolveEntry } from '../util/resolve-entry';

const DEFAULT_PEER_WAIT_MS = 5000;

const peerOption: Options = {
	type: 'string',
	description: 'Invoke on a remote peer by deviceId',
};

const waitOption: Options = {
	type: 'number',
	description: `Total ms to wait for peer resolution + RPC; requires --peer (default ${DEFAULT_PEER_WAIT_MS})`,
};

/**
 * Domain errors returned by {@link runCore}. Carrying the failure mode
 * in-band lets the renderer set `process.exitCode` exactly the way the
 * in-process path does, even when the result arrived over IPC.
 *
 * - `UsageError`: bad action path / missing sync; renderer exitCode=1.
 * - `RuntimeError`: action returned Err locally; renderer exitCode=2.
 * - `PeerMiss`: `--peer` target didn't resolve within `waitMs`; exitCode=3.
 * - `RpcError`: remote RPC returned an `RpcError`; exitCode=2.
 */
export const RunError = defineErrors({
	UsageError: ({
		message,
		suggestions,
	}: {
		message: string;
		suggestions?: string[];
	}) => ({ message, suggestions }),
	RuntimeError: ({ cause }: { cause: unknown }) => ({
		message: extractErrorMessage(cause),
		cause,
	}),
	PeerMiss: ({
		peerTarget,
		sawPeers,
		workspaceArg,
		waitMs,
		emptyReason,
	}: {
		peerTarget: string;
		sawPeers: boolean;
		workspaceArg?: string;
		waitMs: number;
		emptyReason: string | null;
	}) => ({
		message: `no peer matches deviceId "${peerTarget}"`,
		peerTarget,
		sawPeers,
		workspaceArg,
		waitMs,
		emptyReason,
	}),
	RpcError: ({
		cause,
		targetClientId,
		peerState,
	}: {
		cause: RpcError;
		targetClientId: number;
		peerState: AwarenessState;
	}) => ({
		message: `RPC failed: ${cause.name}`,
		cause,
		targetClientId,
		peerState,
	}),
});
export type RunError = InferErrors<typeof RunError>;

/** Success payload for {@link runCore}: the action's return value. */
export type RunSuccess = { data: unknown };

/** {@link runCore}'s return type: `Result` with the {@link RunError} union. */
export type RunResult = Result<RunSuccess, RunError>;

export const runCommand: CommandModule = {
	command: 'run <action> [input]',
	describe:
		'Invoke a defineQuery / defineMutation by dot-path, locally or on a remote peer (--peer)',
	builder: (yargs: Argv) =>
		yargs
			.positional('action', {
				type: 'string',
				demandOption: true,
				describe: 'Action path, e.g. savedTabs.create',
			})
			.positional('input', {
				type: 'string',
				describe: 'Inline JSON or @file.json',
			})
			.option('dir', dirOption)
			.option('workspace', workspaceOption)
			.option('peer', peerOption)
			.option('wait', waitOption)
			.implies('wait', 'peer')
			.options(formatYargsOptions())
			.strict(),
	handler: async (argv) => {
		const args = argv as Record<string, unknown>;
		const actionPath = String(args.action);
		const format = args.format as 'json' | 'jsonl' | undefined;
		const peerTarget =
			typeof args.peer === 'string' && args.peer.length > 0
				? args.peer
				: undefined;
		const waitMs =
			typeof args.wait === 'number' ? args.wait : DEFAULT_PEER_WAIT_MS;
		const target = resolveTarget(args);
		const input = await resolveInput(args);

		const ctx: RunCtx = {
			actionPath,
			input,
			peerTarget,
			waitMs,
			workspaceArg: target.userWorkspace,
		};

		// Attached path: dispatch through the `up` daemon when one is
		// running. Falls through to the standalone path otherwise.
		const daemon = await tryGetDaemon(target);
		if (daemon) {
			const result = await daemon.run(ctx);
			renderRunResult(result, format);
			return;
		}

		// Standalone path: load config in-process.
		await using config = await loadConfig(target.absDir);
		const entry = resolveEntry(config.entries, target.userWorkspace);
		const result = await runCore(entry, ctx);
		renderRunResult(result, format);
	},
};

/**
 * Pure core: dispatch an action either locally or via `sync.rpc`,
 * returning a render-ready {@link RunResult}. No yargs, no config
 * loading, no rendering, so it's usable from the daemon's IPC handler
 * against its already-warm `entry`.
 */
export async function runCore(
	entry: WorkspaceEntry,
	ctx: RunCtx,
): Promise<RunResult> {
	const { workspace } = entry;
	if (workspace.whenReady) await workspace.whenReady;

	const action = resolveActionPath(workspace.actions ?? {}, ctx.actionPath);
	if (!action) {
		const entries = [...walkActions(workspace.actions ?? {})];
		const descendants = entriesUnder(entries, ctx.actionPath);
		if (descendants.length > 0) {
			return RunError.UsageError({
				message: `"${ctx.actionPath}" is not a runnable action.`,
				suggestions: descendants.map(([p, a]) => `  ${p}  (${a.type})`),
			});
		}
		return RunError.UsageError({
			message: `"${ctx.actionPath}" is not defined.`,
			suggestions: nearestSiblingLines(entries, ctx.actionPath),
		});
	}

	if (ctx.peerTarget !== undefined) {
		return invokeRemoteCore(entry, action, ctx);
	}

	const result = await invokeAction(action, ctx.input, ctx.actionPath);
	if (result.error !== null) {
		return RunError.RuntimeError({ cause: result.error });
	}
	return { data: { data: result.data }, error: null };
}

async function invokeRemoteCore(
	entry: WorkspaceEntry,
	_action: Action,
	ctx: RunCtx,
): Promise<RunResult> {
	const { workspace } = entry;
	const sync = workspace.sync;

	if (!sync?.rpc) {
		return RunError.UsageError({
			message: `Workspace "${entry.name}" has no sync attachment; --peer requires sync.`,
		});
	}

	const deadline = Date.now() + ctx.waitMs;
	const { hit, sawPeers } = await waitForPeer(
		workspace,
		ctx.peerTarget!,
		deadline,
	);
	if (!hit) {
		return RunError.PeerMiss({
			peerTarget: ctx.peerTarget!,
			sawPeers,
			workspaceArg: ctx.workspaceArg,
			waitMs: ctx.waitMs,
			emptyReason: explainEmpty(workspace),
		});
	}

	const { clientID: targetClientId, state: peerState } = hit;
	const remaining = Math.max(1, deadline - Date.now());
	const result = await sync.rpc(targetClientId, ctx.actionPath, ctx.input, {
		timeout: remaining,
	});

	if (result.error !== null) {
		return RunError.RpcError({
			cause: result.error,
			targetClientId,
			peerState,
		});
	}
	return { data: { data: result.data }, error: null };
}

function renderRunResult(
	result: Result<RunSuccess, RunError | DaemonError>,
	format: 'json' | 'jsonl' | undefined,
): void {
	if (result.error === null) {
		output(result.data.data, { format });
		return;
	}
	switch (result.error.name) {
		case 'UsageError': {
			outputError(result.error.message);
			if (result.error.suggestions && result.error.suggestions.length > 0) {
				outputError('');
				outputError('Exposed actions at this path:');
				for (const line of result.error.suggestions) outputError(line);
			}
			process.exitCode = 1;
			return;
		}
		case 'RuntimeError':
			outputError(result.error.message);
			process.exitCode = 2;
			return;
		case 'PeerMiss': {
			emitMissError(
				result.error.peerTarget,
				result.error.sawPeers,
				result.error.workspaceArg,
				result.error.waitMs,
			);
			if (result.error.emptyReason)
				outputError(`  reason: ${result.error.emptyReason}`);
			process.exitCode = 3;
			return;
		}
		case 'RpcError':
			emitRpcError(
				result.error.cause,
				result.error.targetClientId,
				result.error.peerState,
			);
			process.exitCode = 2;
			return;
		case 'Required':
		case 'Timeout':
		case 'Unreachable':
		case 'HandlerCrashed':
			outputError(`error: ${result.error.message}`);
			process.exitCode = 1;
			return;
	}
}

async function resolveInput(
	argv: Record<string, unknown>,
): Promise<unknown> {
	const positional =
		typeof argv.input === 'string' && argv.input.length > 0
			? (argv.input as string)
			: undefined;
	const stdinContent = await readStdin();
	return parseJsonInput({ positional, stdinContent });
}

function entriesUnder(
	entries: Array<[string, Action]>,
	prefix: string,
): Array<[string, Action]> {
	if (!prefix) return entries;
	const pfx = prefix + '.';
	return entries.filter(([p]) => p === prefix || p.startsWith(pfx));
}

/**
 * Walk up the requested path looking for the longest prefix that has
 * any exposed actions. Returns suggestion lines (already formatted) or
 * an empty array (same UX as the prior emitter, just data-not-stderr).
 */
function nearestSiblingLines(
	entries: Array<[string, Action]>,
	missedPath: string,
): string[] {
	const parts = missedPath.split('.');
	while (parts.length > 0) {
		parts.pop();
		const prefix = parts.join('.');
		const alts = entriesUnder(entries, prefix);
		if (alts.length === 0) continue;
		return alts.map(([p, a]) => `  ${p}  (${a.type})`);
	}
	return [];
}

// ─── Error formatters ────────────────────────────────────────────────────────

/**
 * Two miss shapes: nothing seen on the wire (probably a connect-status
 * problem; caller should follow with `explainEmpty`) vs peers visible but
 * none matched the requested deviceId (user typo / wrong workspace).
 */
export function emitMissError(
	target: string,
	sawPeers: boolean,
	workspace: string | undefined,
	waitMs: number,
): void {
	const scope = workspace ? ` in workspace ${workspace}` : '';
	if (!sawPeers) {
		outputError(
			`error: no peers seen after waiting ${waitMs}ms for "${target}"`,
		);
		return;
	}
	outputError(`error: no peer matches deviceId "${target}"${scope}`);
	const peersHint = workspace ? ` -w ${workspace}` : '';
	outputError(`run \`epicenter peers${peersHint}\` to see connected peers`);
}

/**
 * Format every `RpcError` variant labeled with the peer's presence info
 * (`device.name`, `device.platform`) at resolution time. The exhaustive
 * switch is enforced at compile time via the `never` check: adding a new
 * variant to `@epicenter/workspace`'s `RpcError` breaks the build until a
 * case is added here.
 */
export function emitRpcError(
	error: RpcError,
	targetClientId: number,
	peerState: AwarenessState,
): void {
	const { device } = peerState;
	const peerLabel = `${device.name} (${targetClientId}, ${device.platform})`;

	switch (error.name) {
		case 'ActionNotFound':
			outputError(`error: ActionNotFound "${error.action}" on ${peerLabel}`);
			return;
		case 'Timeout':
			outputError(`error: timeout after ${error.ms}ms on ${peerLabel}`);
			return;
		case 'PeerOffline':
			outputError(`error: peer ${peerLabel} is offline`);
			return;
		case 'PeerNotFound':
			outputError(`error: no peer with deviceId "${error.peer}"`);
			return;
		case 'PeerLeft':
			outputError(
				`error: peer "${error.peer}" disconnected before responding`,
			);
			return;
		case 'ActionFailed':
			outputError(
				`error: "${error.action}" failed on ${peerLabel}: ${extractErrorMessage(error.cause)}`,
			);
			return;
		case 'Disconnected':
			outputError(`error: connection lost before ${peerLabel} responded`);
			return;
		default:
			error satisfies never;
	}
}
