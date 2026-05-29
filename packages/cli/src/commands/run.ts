/**
 * `epicenter run <mount.action_key> [input]`: invoke a `defineQuery` or
 * `defineMutation` by mount-prefixed action path through the local
 * `epicenter daemon up` daemon.
 *
 * `input` is JSON: inline positional, `@file.json` (curl convention), or stdin.
 * With `--peer <target>`, the invocation is dispatched over the selected
 * mount's RPC channel to a remote peer instead of running locally.
 *
 * `epicenter run` requires a running daemon for the discovered project.
 * Without `daemon up`, the handler errors with a hint pointing at
 * `epicenter daemon up`.
 *
 * Exit codes:
 *   1: usage error (unknown mount, unknown action, invalid input for
 *      `--peer`), or no daemon (`Required`, transport error)
 *   2: runtime error (local action returned Err, or remote RPC failed)
 *   3: peer not found (`--peer <target>` did not resolve within `--wait`)
 */

import type { DispatchError } from '@epicenter/workspace';
import {
	type DaemonError,
	getDaemon,
	type InvokeError,
	type PeerDispatchError,
	type PeerDispatchSyncStatus,
} from '@epicenter/workspace/node';
import { extractErrorMessage } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

import { cmd } from '../util/cmd.js';
import { projectOption } from '../util/common-options.js';
import {
	formatOptions,
	type OutputFormat,
	output,
} from '../util/format-output.js';
import { parseJsonInput, readStdin } from '../util/parse-input.js';

const DEFAULT_PEER_WAIT_MS = 5000;

export const runCommand = cmd({
	command: 'run <action> [input]',
	describe:
		'Invoke a defineQuery / defineMutation by action key, locally or on a remote peer (--peer)',
	builder: (yargs) =>
		yargs
			.positional('action', {
				type: 'string',
				demandOption: true,
				describe: 'Mount-prefixed action path, e.g. notes.notes_add',
			})
			.positional('input', {
				type: 'string',
				describe: 'Inline JSON or @file.json',
			})
			.option('C', projectOption)
			.option('peer', {
				type: 'string',
				description: 'Dispatch to a remote peer by peer id',
			})
			.option('wait', {
				type: 'number',
				description: `RPC deadline in ms for the peer call; requires --peer (default ${DEFAULT_PEER_WAIT_MS})`,
			})
			.implies('wait', 'peer')
			.options(formatOptions)
			.strict(),
	handler: async (argv) => {
		const peerTarget =
			argv.peer && argv.peer.length > 0 ? argv.peer : undefined;
		const waitMs = argv.wait ?? DEFAULT_PEER_WAIT_MS;
		const actionInput = await resolveInput(argv.input);

		const { data: daemon, error: daemonErr } = await getDaemon(argv.C);
		if (daemonErr) {
			console.error(daemonErr.message);
			process.exitCode = 1;
			return;
		}
		const result =
			peerTarget === undefined
				? await daemon.invoke({
						actionPath: argv.action,
						input: actionInput,
					})
				: await daemon.dispatch({
						actionPath: argv.action,
						input: actionInput,
						to: peerTarget,
						waitMs,
					});
		renderRunResult(result, argv.format);
	},
});

function renderRunResult(
	result: Result<unknown, InvokeError | PeerDispatchError | DaemonError>,
	format: OutputFormat | undefined,
): void {
	if (result.error === null) {
		output(result.data, { format });
		return;
	}
	switch (result.error.name) {
		case 'UsageError': {
			console.error(result.error.message);
			if (result.error.suggestions && result.error.suggestions.length > 0) {
				console.error('');
				console.error('Exposed actions at this key:');
				for (const line of result.error.suggestions) console.error(line);
			}
			process.exitCode = 1;
			return;
		}
		case 'RuntimeError':
			console.error(result.error.message);
			process.exitCode = 2;
			return;
		case 'PeerNotFound':
			emitPeerNotFound(
				result.error.to,
				result.error.waitMs,
				result.error.syncStatus,
			);
			process.exitCode = 3;
			return;
		case 'RemoteCallFailed': {
			emitRemoteCallError(result.error.to, result.error.cause);
			process.exitCode = 2;
			return;
		}
		case 'Required':
		case 'Timeout':
		case 'Unreachable':
		case 'HandlerCrashed':
			console.error(`error: ${result.error.message}`);
			process.exitCode = 1;
			return;
		default:
			result.error satisfies never;
			return;
	}
}

async function resolveInput(input: string | undefined): Promise<unknown> {
	const positional = input && input.length > 0 ? input : undefined;
	const stdinContent = await readStdin();
	return parseJsonInput({ positional, stdinContent });
}

function emitPeerNotFound(
	target: string,
	waitMs: number,
	syncStatus: PeerDispatchSyncStatus,
): void {
	console.error(`error: no peer matches peer id "${target}" after ${waitMs}ms`);
	console.error(`  reason: ${describePeerMissReason(syncStatus)}`);
	if (syncStatus.phase === 'connected') {
		console.error('run `epicenter peers` to see connected peers');
	}
}

/**
 * Format every `DispatchError` variant labeled with the peer target. The
 * exhaustive switch is enforced at compile time: adding a new variant to
 * `@epicenter/workspace`'s `DispatchError` breaks the build until a case is
 * added here.
 */
export function emitRemoteCallError(
	peerTarget: string,
	cause: DispatchError,
): void {
	switch (cause.name) {
		case 'Cancelled':
			// The daemon owns the dispatch `AbortSignal` (`AbortSignal.timeout(waitMs)`
			// in action-handler.ts), so a `Cancelled` dispatch error that reaches the
			// CLI is always the `--wait` deadline. Its abort reason is a
			// `DOMException`, which cannot survive the daemon's JSON response, so
			// it is not inspected here.
			console.error(`error: timeout calling ${peerTarget}`);
			return;
		case 'ActionNotFound':
			console.error(`error: ActionNotFound "${cause.action}" on ${peerTarget}`);
			return;
		case 'ActionFailed':
			console.error(
				`error: "${cause.action}" failed on ${peerTarget}: ${cause.cause}`,
			);
			return;
		case 'RecipientOffline':
			console.error(`error: peer ${peerTarget} went offline before responding`);
			return;
		case 'NetworkFailed':
			console.error(
				`error: dispatch to ${peerTarget} failed: ${extractErrorMessage(cause.cause)}`,
			);
			return;
		default:
			cause satisfies never;
	}
}

function describePeerMissReason(status: PeerDispatchSyncStatus): string {
	if (status.phase === 'connected') {
		return 'connected, but no matching peer was visible';
	}
	if (status.phase === 'connecting' && status.lastErrorType) {
		const retries = status.retries;
		const word = retries === 1 ? 'retry' : 'retries';
		return `not connected (${status.lastErrorType} error after ${retries} ${word})`;
	}
	if (status.phase === 'failed') {
		return `not connected (${status.reason.type} ${status.reason.code})`;
	}
	return 'not connected';
}
