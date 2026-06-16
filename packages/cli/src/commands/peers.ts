/**
 * `epicenter peers`: live-device view of who's connected right now.
 *
 * Shows the device id needed to target a peer with `run --peer`.
 * The relay carries only `deviceId` on the wire; product-level
 * display names live in app-owned state and are out of scope here.
 *
 * `epicenter peers` requires a running daemon for the discovered Epicenter root.
 * Without `daemon up`, the handler errors with a hint pointing at
 * `epicenter daemon up`.
 *
 * Prints `no peers connected` to stderr when no peers are connected (text
 * mode only; JSON mode always emits a valid array, even if empty).
 */

import { getDaemon, type PeerSnapshot } from '@epicenter/workspace/node';
import { cmd } from '../util/cmd.js';
import { epicenterRootOption } from '../util/common-options.js';
import {
	fail,
	formatOptions,
	type OutputFormat,
	output,
} from '../util/format-output.js';

export const peersCommand = cmd({
	command: 'peers',
	describe: 'List connected peers (presence)',
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
		const { data: rows, error } = await daemon.peers();
		if (error) {
			fail(error.message);
			return;
		}
		emit(rows, argv.format);
	},
});

function emit(rows: PeerSnapshot[], format: OutputFormat | undefined): void {
	if (format === 'json' || format === 'jsonl') {
		output(rows, { format });
		return;
	}

	const [first] = rows;
	if (!first) {
		console.error('no peers connected');
		return;
	}

	// One daemon serves one mount, so every row shares its mount name: print it
	// once as the canonical app identity, then the connected devices.
	console.log(first.mount);
	console.table(
		rows
			.map((snap) => ({ deviceId: snap.deviceId }))
			.sort((a, b) => a.deviceId.localeCompare(b.deviceId)),
	);
}
