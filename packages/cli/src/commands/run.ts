/**
 * `epicenter run <dot.path> [args...]` — invoke a `defineQuery` /
 * `defineMutation` by dot-path through an opened document handle.
 *
 * With `--peer <target>`, the invocation is dispatched over the sync
 * room's RPC channel to a remote peer instead of running locally.
 */

import { isResult, iterateActions } from '@epicenter/workspace';
import type { TSchema } from 'typebox';
import { extractErrorMessage } from 'wellcrafted/error';
import type { Argv, CommandModule, Options } from 'yargs';
import { loadConfig, type LoadConfigResult } from '../load-config';
import { dirFromArgv, dirOption } from '../util/dir-option';
import { findPeer, type AwarenessState, type FindPeerResult } from '../util/find-peer';
import {
	formatYargsOptions,
	output,
	outputError,
} from '../util/format-output';
import { getSync, readPeers } from '../util/handle-attachments';
import { parseJsonInput, readStdinSync } from '../util/parse-input';
import { resolveEntry } from '../util/resolve-entry';
import { resolvePath } from '../util/resolve-path';
import { typeboxToYargsOptions } from '../util/typebox-to-yargs';
import { workspaceFromArgv, workspaceOption } from '../util/workspace-option';

const POLL_INTERVAL_MS = 100;
const DEFAULT_PEER_TIMEOUT_MS = 5000;

const peerOption: Options = {
	type: 'string',
	description:
		'Remote peer target: bare deviceName, <field>=<value>, or numeric clientID',
};

const timeoutOption: Options = {
	type: 'number',
	default: DEFAULT_PEER_TIMEOUT_MS,
	description: `Remote RPC timeout in ms (default ${DEFAULT_PEER_TIMEOUT_MS})`,
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
			.option('file', {
				type: 'string',
				description: 'Path to a JSON file containing the action input',
			})
			.option('dir', dirOption)
			.option('workspace', workspaceOption)
			.option('peer', peerOption)
			.option('timeout', timeoutOption)
			.options(formatYargsOptions())
			.strict(false),
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
	const actionPath = String(argv.action ?? '');
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
	const input = await resolveInput(argv, action);
	const format = argv.format as 'json' | 'jsonl' | undefined;

	const peerTarget =
		typeof argv.peer === 'string' && argv.peer.length > 0 ? argv.peer : undefined;
	if (peerTarget !== undefined) {
		await invokeRemote(argv, entry, actionPath, input, peerTarget);
		return;
	}

	const raw =
		action.input !== undefined ? await action(input) : await action();
	if (isResult(raw)) {
		if (raw.error !== null) {
			outputError(extractErrorMessage(raw.error));
			process.exitCode = 1;
			return;
		}
		output(raw.data, { format });
		return;
	}
	output(raw, { format });
}

async function invokeRemote(
	argv: Record<string, unknown>,
	entry: LoadConfigResult['entries'][number],
	actionPath: string,
	input: unknown,
	peerTarget: string,
): Promise<void> {
	const sync = getSync(entry.handle);

	if (!sync?.rpc) {
		outputError(
			`Workspace "${entry.name}" has no sync attachment; --peer requires sync.`,
		);
		process.exitCode = 1;
		return;
	}

	const timeoutMs = argv.timeout as number;
	const format = argv.format as 'json' | 'jsonl' | undefined;
	const workspaceArg = workspaceFromArgv(argv);

	if (sync.whenConnected) await sync.whenConnected;

	const deadline = Date.now() + timeoutMs;
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
		emitMissError(peerTarget, lastResult, sawPeers, workspaceArg, timeoutMs);
		process.exitCode = 1;
		return;
	}

	const targetClientId = lastResult.clientID;
	const peerState = readPeers(entry.handle).get(targetClientId) ?? {};
	const remaining = Math.max(1, deadline - Date.now());
	const result = await sync.rpc(targetClientId, actionPath, input, {
		timeout: remaining,
	});

	if (result.error !== null) {
		emitRpcError(result.error, targetClientId, peerState);
		process.exitCode = 1;
		return;
	}
	output(result.data, { format });
}

export function emitMissError(
	target: string,
	result: FindPeerResult,
	sawPeers: boolean,
	workspace: string | undefined,
	timeoutMs: number,
): void {
	const scope = workspace ? ` in workspace ${workspace}` : '';
	if (result.kind === 'case-suggest') {
		outputError(`error: no peer matches "${target}"${scope}`);
		outputError(`did you mean: ${result.actual}?`);
		return;
	}
	if (result.kind === 'case-ambiguous') {
		outputError(`error: no peer matches "${target}"${scope}`);
		outputError('multiple peers match case-insensitively:');
		for (const match of result.matches) {
			outputError(`  ${match.value.padEnd(16)} (${match.clientID})`);
		}
		return;
	}
	if (!sawPeers) {
		outputError(`error: timeout after ${timeoutMs}ms waiting for peer ${target}`);
		return;
	}
	outputError(`error: no peer matches "${target}"${scope}`);
	const peersHint = workspace ? ` -w ${workspace}` : '';
	outputError(`run \`epicenter peers${peersHint}\` to see connected peers`);
}

export function emitRpcError(
	error: unknown,
	targetClientId: number,
	peerState: AwarenessState,
): void {
	if (error == null || typeof error !== 'object' || !('name' in error)) {
		outputError(`error: ${extractErrorMessage(error)}`);
		return;
	}
	const e = error as {
		name: string;
		action?: string;
		ms?: number;
		cause?: unknown;
	};
	const deviceName =
		typeof peerState.deviceName === 'string' ? peerState.deviceName : undefined;
	const version =
		typeof peerState.version === 'string' ? peerState.version : undefined;
	const peerLabel = formatPeerLabel(targetClientId, deviceName, version);

	switch (e.name) {
		case 'ActionNotFound':
			outputError(`error: ActionNotFound "${e.action}" on ${peerLabel}`);
			return;
		case 'Timeout':
			outputError(
				`error: timeout after ${e.ms}ms on ${peerLabel}`,
			);
			return;
		case 'PeerOffline':
			outputError(`error: peer ${peerLabel} is offline`);
			return;
		case 'ActionFailed':
			outputError(
				`error: "${e.action}" failed on ${peerLabel}: ${extractErrorMessage(e.cause)}`,
			);
			return;
		case 'Disconnected':
			outputError(`error: connection lost before ${peerLabel} responded`);
			return;
		default:
			outputError(`error: ${extractErrorMessage(error)}`);
	}
}

function formatPeerLabel(
	clientId: number,
	deviceName: string | undefined,
	version: string | undefined,
): string {
	const idAndVersion = version ? `${clientId}, v${version}` : String(clientId);
	return deviceName ? `${deviceName} (${idAndVersion})` : `clientID ${clientId}`;
}

async function resolveInput(
	argv: Record<string, unknown>,
	action: { input?: TSchema },
): Promise<unknown> {
	if (action.input === undefined) return undefined;

	// Escape hatch: positional `@file.json`, inline JSON, `--file`, or stdin.
	const positional =
		typeof argv.input === 'string' && argv.input.length > 0
			? (argv.input as string)
			: undefined;
	const file = typeof argv.file === 'string' ? (argv.file as string) : undefined;
	const stdinContent = readStdinSync();
	const hasStdin = stdinContent !== undefined;

	if (positional || file || hasStdin) {
		const { data, error } = parseJsonInput({
			positional,
			file,
			hasStdin,
			stdinContent,
		});
		if (error) throw new Error(error.message);
		return data;
	}

	// Flat schemas: map TypeBox fields to yargs flags already parsed by yargs.
	const yargsOpts = typeboxToYargsOptions(action.input);
	const input: Record<string, unknown> = {};
	for (const key of Object.keys(yargsOpts)) {
		if (argv[key] !== undefined) input[key] = argv[key];
	}
	return input;
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
