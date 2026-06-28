/**
 * `epicenter devices`: the per-person device roster from the account doc.
 *
 * Shows every device this account has listed: its `peerId` (the iroh public key
 * you dial) and its `label` (hostname by default). Distinct from
 * `epicenter peers`, which is live presence in ONE workspace room; this is the
 * cross-device roster the account doc syncs, online or not.
 *
 * The roster is the device-local reducer's fold of the account doc's signed
 * assertions, so what prints here verified under each device's own key: the
 * cloud relays the log but cannot forge an entry into it.
 *
 * Requires a running daemon for the discovered Epicenter root (the daemon owns
 * the account-room connection). Without `daemon up`, the handler errors with a
 * hint pointing at `epicenter daemon up`. Prints `no devices` to stderr when the
 * roster is empty (text mode only; JSON mode always emits a valid array).
 */

import { getDaemon, type DeviceSnapshot } from '@epicenter/workspace/node';
import { cmd } from '../util/cmd.js';
import { epicenterRootOption } from '../util/common-options.js';
import {
	fail,
	formatOptions,
	type OutputFormat,
	output,
} from '../util/format-output.js';

export const devicesCommand = cmd({
	command: 'devices',
	describe: "List this account's devices (account-doc roster)",
	builder: {
		C: epicenterRootOption,
		...formatOptions,
	},
	handler: async (argv) => {
		const { data: daemon, error: daemonErr } = await getDaemon(argv.C);
		if (daemonErr) {
			fail(daemonErr.message);
			return;
		}
		const { data: rows, error } = await daemon.devices();
		if (error) {
			fail(error.message);
			return;
		}
		emit(rows, argv.format);
	},
});

function emit(rows: DeviceSnapshot[], format: OutputFormat | undefined): void {
	if (format === 'json' || format === 'jsonl') {
		output(rows, { format });
		return;
	}

	if (rows.length === 0) {
		console.error('no devices');
		return;
	}

	console.table(
		rows
			.map((snap) => ({ peerId: snap.peerId, label: snap.label }))
			.sort((a, b) => a.label.localeCompare(b.label)),
	);
}
