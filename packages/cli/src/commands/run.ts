/**
 * `epicenter run <dot.path> [input]` — invoke a `defineQuery` /
 * `defineMutation` by dot-path through a loaded workspace.
 *
 * `input` is JSON: inline positional, `@file.json` (curl convention), or stdin.
 * With `--peer <target>`, the invocation is dispatched over the sync
 * room's RPC channel to a remote peer instead of running locally.
 *
 * Exit codes:
 *   1 — usage error (unknown action, workspace miss, missing sync for `--peer`)
 *   2 — runtime error (local action returned Err, or remote RPC failed)
 *   3 — peer-miss (`--peer <target>` didn't resolve within `--wait`)
 *
 * ## Auto-detect (Wave 6)
 *
 * If an `epicenter up` daemon is running for the same `--dir`, the yargs
 * handler dispatches through {@link ipcCall} and the daemon executes
 * {@link runCore} against its already-warm workspace. The result shape
 * ({@link RunResult}) is the same on either side so the renderer doesn't
 * branch.
 */

import { resolve } from 'node:path';
import {
	type Action,
	invokeAction,
	resolveActionPath,
	type RpcError,
	walkActions,
} from '@epicenter/workspace';
import type { AwarenessState } from '../load-config';
import { extractErrorMessage } from 'wellcrafted/error';
import type { Argv, CommandModule, Options } from 'yargs';
import { ipcCall, ipcPing } from '../daemon/ipc-client';
import { socketPathFor } from '../daemon/paths';
import { loadConfig, type WorkspaceEntry } from '../load-config';
import {
	dirFromArgv,
	dirOption,
	workspaceFromArgv,
	workspaceOption,
} from '../util/common-options';
import { formatYargsOptions, output, outputError } from '../util/format-output';
import { parseJsonInput, readStdin } from '../util/parse-input';
import { explainEmpty, waitForPeer } from '../util/peer-wait';
import { resolveEntry } from '../util/resolve-entry';
import { emitMissError, emitRpcError } from '../util/run-peer-errors';
import { inheritWorkspace } from './list';

const DEFAULT_PEER_WAIT_MS = 5000;

const peerOption: Options = {
	type: 'string',
	description: 'Invoke on a remote peer by deviceId',
};

const waitOption: Options = {
	type: 'number',
	description: `Total ms to wait for peer resolution + RPC; requires --peer (default ${DEFAULT_PEER_WAIT_MS})`,
};

const noUpOption: Options = {
	type: 'boolean',
	default: false,
	description:
		'Skip the `epicenter up` daemon if one is running and use a transient connection instead',
};

/**
 * Parsed inputs for {@link runCore}. Mirrors {@link ListCtx} — the daemon
 * builds it from IPC `args`, the local handler builds it from argv. The
 * shape is the wire format too.
 */
export type RunCtx = {
	actionPath: string;
	input: unknown;
	peerTarget?: string;
	waitMs: number;
	workspaceArg?: string;
};

/**
 * Result of {@link runCore}. The renderer turns every variant into
 * stdout / stderr / exitCode. Carrying the exit code in-band is the
 * thing that lets the IPC path drive `process.exitCode` exactly the way
 * the in-process path does.
 *
 * - `ok`: action ran, `data` is the return value (rendered to stdout).
 * - `usageError`: bad action path / missing sync; exitCode=1.
 * - `runtimeError`: action returned Err (or remote RPC failed); exitCode=2.
 * - `peerMiss`: `--peer` target didn't resolve within `waitMs`; exitCode=3.
 */
export type RunResult =
	| { kind: 'ok'; data: unknown }
	| { kind: 'usageError'; message: string; suggestions?: string[] }
	| { kind: 'runtimeError'; message: string }
	| {
			kind: 'peerMiss';
			peerTarget: string;
			sawPeers: boolean;
			workspaceArg?: string;
			waitMs: number;
			emptyReason: string | null;
	  }
	| {
			kind: 'rpcError';
			error: RpcError;
			targetClientId: number;
			peerState: AwarenessState;
	  };

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
			.option('no-up', noUpOption)
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
		const noUp = args['no-up'] === true;
		const userWorkspace = workspaceFromArgv(args);
		const input = await resolveInput(args);

		const ctx: RunCtx = {
			actionPath,
			input,
			peerTarget,
			waitMs,
			workspaceArg: userWorkspace,
		};

		// Auto-detect path.
		if (!noUp) {
			const absDir = resolve(dirFromArgv(args));
			const sock = socketPathFor(absDir);
			if (await ipcPing(sock)) {
				const inherited = inheritWorkspace(absDir, userWorkspace);
				if (inherited === 'mismatch') return; // exitCode already set
				const reply = await ipcCall<RunResult>(sock, 'run', {
					...ctx,
					workspaceArg: inherited,
				});
				if (reply.ok) {
					renderRunResult(reply.data, format);
					return;
				}
				outputError(`error: ${reply.error.message}`);
				process.exitCode = 1;
				return;
			}
		}

		// Fallback: load config in-process.
		await using config = await loadConfig(dirFromArgv(args));
		const entry = resolveEntry(config.entries, userWorkspace);
		const result = await runCore(entry, ctx);
		renderRunResult(result, format);
	},
};

/**
 * Pure core: dispatch an action either locally or via `sync.rpc`,
 * returning a render-ready {@link RunResult}. No yargs, no config
 * loading, no rendering — usable from the daemon's IPC handler against
 * its already-warm `entry`.
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
			return {
				kind: 'usageError',
				message: `"${ctx.actionPath}" is not a runnable action.`,
				suggestions: descendants.map(([p, a]) => `  ${p}  (${a.type})`),
			};
		}
		return {
			kind: 'usageError',
			message: `"${ctx.actionPath}" is not defined.`,
			suggestions: nearestSiblingLines(entries, ctx.actionPath),
		};
	}

	if (ctx.peerTarget !== undefined) {
		return invokeRemoteCore(entry, action, ctx);
	}

	const result = await invokeAction(action, ctx.input, ctx.actionPath);
	if (result.error !== null) {
		return { kind: 'runtimeError', message: extractErrorMessage(result.error) };
	}
	return { kind: 'ok', data: result.data };
}

async function invokeRemoteCore(
	entry: WorkspaceEntry,
	_action: Action,
	ctx: RunCtx,
): Promise<RunResult> {
	const { workspace } = entry;
	const sync = workspace.sync;

	if (!sync?.rpc) {
		return {
			kind: 'usageError',
			message: `Workspace "${entry.name}" has no sync attachment; --peer requires sync.`,
		};
	}

	const deadline = Date.now() + ctx.waitMs;
	const { hit, sawPeers } = await waitForPeer(
		workspace,
		ctx.peerTarget!,
		deadline,
	);
	if (!hit) {
		return {
			kind: 'peerMiss',
			peerTarget: ctx.peerTarget!,
			sawPeers,
			workspaceArg: ctx.workspaceArg,
			waitMs: ctx.waitMs,
			emptyReason: explainEmpty(workspace),
		};
	}

	const { clientID: targetClientId, state: peerState } = hit;
	const remaining = Math.max(1, deadline - Date.now());
	const result = await sync.rpc(targetClientId, ctx.actionPath, ctx.input, {
		timeout: remaining,
	});

	if (result.error !== null) {
		return {
			kind: 'rpcError',
			error: result.error,
			targetClientId,
			peerState,
		};
	}
	return { kind: 'ok', data: result.data };
}

function renderRunResult(
	result: RunResult,
	format: 'json' | 'jsonl' | undefined,
): void {
	switch (result.kind) {
		case 'ok':
			output(result.data, { format });
			return;
		case 'usageError': {
			outputError(result.message);
			if (result.suggestions && result.suggestions.length > 0) {
				outputError('');
				outputError('Exposed actions at this path:');
				for (const line of result.suggestions) outputError(line);
			}
			process.exitCode = 1;
			return;
		}
		case 'runtimeError':
			outputError(result.message);
			process.exitCode = 2;
			return;
		case 'peerMiss': {
			emitMissError(
				result.peerTarget,
				result.sawPeers,
				result.workspaceArg,
				result.waitMs,
			);
			if (result.emptyReason) outputError(`  reason: ${result.emptyReason}`);
			process.exitCode = 3;
			return;
		}
		case 'rpcError':
			emitRpcError(result.error, result.targetClientId, result.peerState);
			process.exitCode = 2;
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
 * an empty array — same UX as the prior emitter, just data-not-stderr.
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
