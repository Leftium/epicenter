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

import { isResult, iterateActions } from '@epicenter/workspace';
import { extractErrorMessage } from 'wellcrafted/error';
import type { Argv, CommandModule, Options } from 'yargs';
import { loadConfig, type LoadConfigResult } from '../load-config';
import { dirFromArgv, dirOption } from '../util/dir-option';
import { emitMissError, emitRpcError } from '../util/emit-peer-errors';
import { EXIT } from '../util/exit-codes';
import { findPeer, type FindPeerResult } from '../util/find-peer';
import { formatYargsOptions, output, outputError } from '../util/format-output';
import { getSync, readPeers } from '../util/handle-attachments';
import { parseJsonInput, readStdin } from '../util/parse-input';
import { resolveEntry } from '../util/resolve-entry';
import { resolvePath } from '../util/resolve-path';
import { workspaceFromArgv, workspaceOption } from '../util/workspace-option';

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
			await Promise.all(
				entries.map(async (entry) => {
					const sync = getSync(entry.handle);
					if (sync?.whenDisposed) await sync.whenDisposed;
				}),
			);
		}
	},
};

async function invoke(
	argv: Record<string, unknown>,
	entry: LoadConfigResult['entries'][number],
): Promise<void> {
	const actionPath = String(argv.action);
	const segments = actionPath.split('.').filter(Boolean);

	if (segments.length === 0) {
		throw new Error('Provide an action path, e.g. `savedTabs.list`.');
	}

	if (entry.handle.whenReady) await entry.handle.whenReady;

	const resolved = resolvePath(entry.handle, segments);

	if (resolved.kind === 'missing') {
		outputError(
			`"${actionPath}" is not defined. ` +
				`Stopped at "${resolved.lastGoodPath.join('.')}" ` +
				`while looking for "${resolved.missingSegment}".`,
		);
		suggestSiblings(entry.handle, resolved.lastGoodPath);
		throw new Error('Action not found');
	}

	if (resolved.kind === 'subtree') {
		outputError(`"${actionPath}" is not a runnable action.`);
		suggestSiblings(entry.handle, resolved.path);
		throw new Error('Not an action');
	}

	const { action } = resolved;
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
			process.exitCode = EXIT.RUNTIME;
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
		process.exitCode = EXIT.PEER_MISS;
		return;
	}

	const { clientID: targetClientId, state: peerState } = lastResult;
	const remaining = Math.max(1, deadline - Date.now());
	const result = await sync.rpc(targetClientId, actionPath, input, {
		timeout: remaining,
	});

	if (result.error !== null) {
		emitRpcError(result.error, targetClientId, peerState);
		process.exitCode = EXIT.RUNTIME;
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

	if (!positional && stdinContent === undefined) return undefined;

	const { data, error } = parseJsonInput({ positional, stdinContent });
	if (error) throw new Error(error.message);
	return data;
}

function suggestSiblings(bundle: unknown, parentPath: string[]): void {
	let node: unknown = bundle;
	for (const seg of parentPath) {
		if (node == null || typeof node !== 'object') return;
		node = (node as Record<string, unknown>)[seg];
	}
	if (node == null || typeof node !== 'object') return;

	const siblings = [...iterateActions(node)];
	if (siblings.length === 0) return;

	outputError('');
	outputError('Exposed actions at this path:');
	for (const [action, path] of siblings) {
		const full = [...parentPath, ...path].join('.');
		outputError(`  ${full}  (${action.type})`);
	}
}
