/**
 * `epicenter run <dot.path> [input]` — invoke a `defineQuery` /
 * `defineMutation` by dot-path through an opened document handle.
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

import { isResult } from '@epicenter/workspace';
import { extractErrorMessage } from 'wellcrafted/error';
import type { Argv, CommandModule, Options } from 'yargs';
import { loadConfig, type LoadConfigResult } from '../load-config';
import type { ActionIndex } from '../util/action-index';
import {
	dirFromArgv,
	dirOption,
	workspaceFromArgv,
	workspaceOption,
} from '../util/common-options';
import { emitMissError, emitRpcError } from '../util/emit-peer-errors';
import { findPeer, type FindPeerResult } from '../util/find-peer';
import { formatYargsOptions, output, outputError } from '../util/format-output';
import { getSync, readPeers } from '../util/handle-attachments';
import { parseJsonInput, readStdin } from '../util/parse-input';
import { resolveEntry } from '../util/resolve-entry';

const POLL_INTERVAL_MS = 100;
const DEFAULT_PEER_WAIT_MS = 5000;

const peerOption: Options = {
	type: 'string',
	description:
		'Remote peer target: <field>=<value> or numeric clientID',
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
		const { entries, dispose } = await loadConfig(dirFromArgv(args));
		try {
			const entry = resolveEntry(entries, workspaceFromArgv(args));
			await invoke(args, entry);
		} finally {
			await dispose();
		}
	},
};

async function invoke(
	argv: Record<string, unknown>,
	entry: LoadConfigResult['entries'][number],
): Promise<void> {
	const actionPath = String(argv.action);

	if (entry.handle.whenReady) await entry.handle.whenReady;

	const action = entry.actions.get(actionPath);
	if (!action) {
		const descendants = entry.actions.under(actionPath);
		if (descendants.length > 0) {
			outputError(`"${actionPath}" is not a runnable action.`);
			emitActionList(descendants);
			throw new Error('Not an action');
		}
		outputError(`"${actionPath}" is not defined.`);
		emitNearestSiblings(entry.actions, actionPath);
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

	const raw =
		action.input !== undefined ? await action(input) : await action();
	if (isResult(raw)) {
		if (raw.error !== null) {
			outputError(extractErrorMessage(raw.error));
			process.exitCode = 2; // runtime error (local Err)
			return;
		}
		output(raw.data, { format });
		return;
	}
	output(raw, { format });
}

type InvokeRemoteOptions = {
	entry: LoadConfigResult['entries'][number];
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
	const sync = getSync(entry.handle);

	if (!sync?.rpc) {
		throw new Error(
			`Workspace "${entry.name}" has no sync attachment; --peer requires sync.`,
		);
	}

	if (sync.whenConnected) await sync.whenConnected;

	const deadline = Date.now() + waitMs;
	let lastResult: FindPeerResult = { kind: 'not-found' };
	let sawPeers = false;

	while (true) {
		const peers = readPeers(entry.handle);
		if (peers.size > 0) sawPeers = true;
		lastResult = findPeer(peerTarget, peers);
		if (lastResult.kind !== 'not-found') break;
		if (Date.now() >= deadline) break;
		await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
	}

	if (lastResult.kind !== 'found') {
		emitMissError(peerTarget, lastResult, sawPeers, workspaceArg, waitMs);
		process.exitCode = 3; // peer miss
		return;
	}

	const { clientID: targetClientId, state: peerState } = lastResult;
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

	const { data, error } = parseJsonInput({ positional, stdinContent });
	if (error) throw new Error(error.message);
	return data;
}

function emitActionList(
	descendants: Array<[string, { type: string }]>,
): void {
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
	actions: ActionIndex,
	missedPath: string,
): void {
	const parts = missedPath.split('.');
	while (parts.length > 0) {
		parts.pop();
		const prefix = parts.join('.');
		const alts = actions.under(prefix);
		if (alts.length === 0) continue;
		emitActionList(alts);
		return;
	}
}
