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
 */

import {
	type Action,
	invokeAction,
	resolveActionPath,
	walkActions,
} from '@epicenter/workspace';
import { extractErrorMessage } from 'wellcrafted/error';
import type { Argv, CommandModule, Options } from 'yargs';
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

const DEFAULT_PEER_WAIT_MS = 5000;

const peerOption: Options = {
	type: 'string',
	description: 'Invoke on a remote peer by deviceId',
};

const waitOption: Options = {
	type: 'number',
	description: `Total ms to wait for peer resolution + RPC; requires --peer (default ${DEFAULT_PEER_WAIT_MS})`,
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
			.implies('wait', 'peer')
			.options(formatYargsOptions())
			.strict(),
	handler: async (argv) => {
		const args = argv as Record<string, unknown>;
		await using config = await loadConfig(dirFromArgv(args));
		const entry = resolveEntry(config.entries, workspaceFromArgv(args));
		await invoke(args, entry);
	},
};

async function invoke(
	argv: Record<string, unknown>,
	entry: WorkspaceEntry,
): Promise<void> {
	const actionPath = String(argv.action);
	const { workspace } = entry;

	if (workspace.whenReady) await workspace.whenReady;

	const action = resolveActionPath(workspace.actions ?? {}, actionPath);
	if (!action) {
		const entries = [...walkActions(workspace.actions ?? {})];
		const descendants = entriesUnder(entries, actionPath);
		if (descendants.length > 0) {
			outputError(`"${actionPath}" is not a runnable action.`);
			emitActionList(descendants);
			throw new Error('Not an action');
		}
		outputError(`"${actionPath}" is not defined.`);
		emitNearestSiblings(entries, actionPath);
		throw new Error('Action not found');
	}

	const input = await resolveInput(argv);
	const format = argv.format as 'json' | 'jsonl' | undefined;

	const peerTarget =
		typeof argv.peer === 'string' && argv.peer.length > 0 ? argv.peer : undefined;
	if (peerTarget !== undefined) {
		const waitMs =
			typeof argv.wait === 'number' ? argv.wait : DEFAULT_PEER_WAIT_MS;
		await invokeRemote({
			entry,
			actionPath,
			input,
			peerTarget,
			waitMs,
			format,
			workspaceArg: workspaceFromArgv(argv),
		});
		return;
	}

	const result = await invokeAction(action, input, actionPath);
	if (result.error !== null) {
		outputError(extractErrorMessage(result.error));
		process.exitCode = 2; // runtime error (local Err)
		return;
	}
	output(result.data, { format });
}

type InvokeRemoteOptions = {
	entry: WorkspaceEntry;
	actionPath: string;
	input: unknown;
	peerTarget: string;
	waitMs: number;
	format: 'json' | 'jsonl' | undefined;
	workspaceArg: string | undefined;
};

async function invokeRemote({
	entry,
	actionPath,
	input,
	peerTarget,
	waitMs,
	format,
	workspaceArg,
}: InvokeRemoteOptions): Promise<void> {
	const { workspace } = entry;
	const sync = workspace.sync;

	if (!sync?.rpc) {
		throw new Error(
			`Workspace "${entry.name}" has no sync attachment; --peer requires sync.`,
		);
	}

	// `--wait` is the end-to-end budget: peer resolution + RPC share one
	// deadline. If the peer is already in awareness, RPC gets the full
	// budget; if peer resolution chews 4s of 5s, RPC gets 1s. Users care
	// about total latency, not per-phase breakdown — see waitOption
	// description.
	const deadline = Date.now() + waitMs;
	const { hit, sawPeers } = await waitForPeer(workspace, peerTarget, deadline);
	if (!hit) {
		emitMissError(peerTarget, sawPeers, workspaceArg, waitMs);
		const why = explainEmpty(workspace);
		if (why) outputError(`  reason: ${why}`);
		process.exitCode = 3; // peer miss
		return;
	}

	const { clientID: targetClientId, state: peerState } = hit;
	const remaining = Math.max(1, deadline - Date.now());
	const result = await sync.rpc(targetClientId, actionPath, input, {
		timeout: remaining,
	});

	if (result.error !== null) {
		emitRpcError(result.error, targetClientId, peerState);
		process.exitCode = 2; // runtime error (remote RPC)
		return;
	}
	output(result.data, { format });
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

function emitActionList(descendants: Array<[string, Action]>): void {
	outputError('');
	outputError('Exposed actions at this path:');
	for (const [path, action] of descendants) {
		outputError(`  ${path}  (${action.type})`);
	}
}

/**
 * After a miss, walk up the requested path looking for the longest prefix
 * that has any exposed actions and emit them as suggestions. If nothing
 * matches, stay silent — the top-level "not defined" error stands alone.
 */
function emitNearestSiblings(
	entries: Array<[string, Action]>,
	missedPath: string,
): void {
	const parts = missedPath.split('.');
	while (parts.length > 0) {
		parts.pop();
		const prefix = parts.join('.');
		const alts = entriesUnder(entries, prefix);
		if (alts.length === 0) continue;
		emitActionList(alts);
		return;
	}
}
