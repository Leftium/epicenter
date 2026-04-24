/**
 * Process exit codes surfaced by the CLI. Scripts consuming `epicenter`
 * output can distinguish these cases without parsing stderr.
 *
 *   1 — usage / setup error (unknown command, missing config, bad action
 *       path, workspace not found). Emitted by throwing; yargs maps it.
 *   2 — runtime error (local action returned Err, or remote RPC failed).
 *       The request was understood but the target could not satisfy it.
 *   3 — peer miss (`--peer <target>` did not resolve within `--wait`).
 *       Distinct from 2 so scripts can retry/re-enumerate peers without
 *       treating this as a generic remote failure.
 */
export const EXIT = {
	USAGE: 1,
	RUNTIME: 2,
	PEER_MISS: 3,
} as const;
