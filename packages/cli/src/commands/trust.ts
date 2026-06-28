/**
 * `epicenter verify`, `epicenter revoke`, `epicenter sas`: the trust write side
 * of the per-person account doc.
 *
 * Trust is depth-1, rooted in the local device's key. `verify <peerId>` is
 * existing-device approval: this already-trusted daemon signs a `verify` into the
 * account room doc, lifting the subject to `verified` (it syncs to the fleet and
 * the gateway re-reads it on the next inbound connection, so no restart). `revoke
 * <peerId>` signs the opposite. `sas <peerId>` prints the 6-digit short
 * authentication string for the (this device, subject) pair, the code a human
 * reads off both screens before approving a brand-new device out of band.
 *
 * All three write through (or read from) the account-room Y.Doc the daemon
 * already holds, so they require a running daemon with a signed-in session. The
 * peerId is the subject device's iroh public key; see `epicenter devices`.
 */

import { getDaemon } from '@epicenter/workspace/node';
import { cmd } from '../util/cmd.js';
import { epicenterRootOption } from '../util/common-options.js';
import {
	fail,
	formatOptions,
	type OutputFormat,
	output,
} from '../util/format-output.js';

/** Shared option surface: a `<peerId>` positional plus root + format. */
function verdictBuilder(
	verb: 'verify' | 'revoke' | 'derive a SAS for',
) {
	return (
		yargs: import('yargs').Argv<Record<never, never>>,
	) =>
		yargs
			.positional('peerId', {
				type: 'string' as const,
				demandOption: true,
				describe: `Subject device peer id to ${verb} (see \`epicenter devices\`)`,
			})
			.option('C', epicenterRootOption)
			.options(formatOptions)
			.strict();
}

export const verifyCommand = cmd({
	command: 'verify <peerId>',
	describe: 'Approve a device: sign a verify into the account doc',
	builder: verdictBuilder('verify'),
	handler: async (argv) => {
		const { data: daemon, error: daemonErr } = await getDaemon(argv.C);
		if (daemonErr) {
			fail(daemonErr.message);
			return;
		}
		const { data, error } = await daemon.verify({ peerId: argv.peerId });
		if (error) {
			fail(error.message);
			return;
		}
		emitVerdict('verified', data, argv.format);
	},
});

export const revokeCommand = cmd({
	command: 'revoke <peerId>',
	describe: 'Distrust a device: sign a revoke into the account doc',
	builder: verdictBuilder('revoke'),
	handler: async (argv) => {
		const { data: daemon, error: daemonErr } = await getDaemon(argv.C);
		if (daemonErr) {
			fail(daemonErr.message);
			return;
		}
		const { data, error } = await daemon.revoke({ peerId: argv.peerId });
		if (error) {
			fail(error.message);
			return;
		}
		emitVerdict('revoked', data, argv.format);
	},
});

export const sasCommand = cmd({
	command: 'sas <peerId>',
	describe: 'Print the 6-digit short authentication string for a device pair',
	builder: verdictBuilder('derive a SAS for'),
	handler: async (argv) => {
		const { data: daemon, error: daemonErr } = await getDaemon(argv.C);
		if (daemonErr) {
			fail(daemonErr.message);
			return;
		}
		const { data, error } = await daemon.sas({ peerId: argv.peerId });
		if (error) {
			fail(error.message);
			return;
		}
		if (argv.format === 'json' || argv.format === 'jsonl') {
			output(data, { format: argv.format });
			return;
		}
		process.stdout.write(`${data.sas}\n`);
	},
});

function emitVerdict(
	verb: 'verified' | 'revoked',
	data: { peerId: string; seq: number },
	format: OutputFormat | undefined,
): void {
	if (format === 'json' || format === 'jsonl') {
		output({ ...data, verb }, { format });
		return;
	}
	process.stderr.write(`${verb} ${data.peerId} (seq ${data.seq})\n`);
}
