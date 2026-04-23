/**
 * Shared `--peer` / `--timeout` flags for `run --peer <target>`.
 *
 * Mirrors the convention used by `workspaceOption`: an `Options` object for
 * yargs, plus a parser that extracts a well-typed value from argv.
 */

import type { Options } from 'yargs';

export const DEFAULT_PEER_TIMEOUT_MS = 5000;

export const peerOption: Options = {
	type: 'string',
	description:
		'Remote peer target: bare deviceName, <field>=<value>, or numeric clientID',
};

export const timeoutOption: Options = {
	type: 'number',
	default: DEFAULT_PEER_TIMEOUT_MS,
	description: `Remote RPC timeout in ms (default ${DEFAULT_PEER_TIMEOUT_MS})`,
};

export function peerFromArgv(argv: Record<string, unknown>): string | undefined {
	return typeof argv.peer === 'string' && argv.peer.length > 0
		? argv.peer
		: undefined;
}

export function timeoutFromArgv(argv: Record<string, unknown>): number {
	return typeof argv.timeout === 'number' && argv.timeout > 0
		? argv.timeout
		: DEFAULT_PEER_TIMEOUT_MS;
}
