/**
 * `epicenter tools <device>` and `epicenter call <device> <route> <tool>`: the
 * cross-device tool loop, target-device-FIRST.
 *
 * You name the device you want, not a tool floating in a global namespace: the
 * picker resolves `<device>` against the relay floor's live presence (the
 * same-owner devices currently online), then the LOCAL daemon opens a channel to
 * that device over the relay, runs an MCP session against the named route, and
 * lists or calls. The remote admits the channel on owner identity and a
 * relay-exposed route, so a route the target has not exposed is refused before
 * any tool runs.
 *
 * Both require a running daemon with a signed-in session (it holds the
 * account-room connection the relay rides). You reach a device that is online,
 * addressed by its nodeId; an offline device is unreachable and is not listed.
 */

import { type DaemonClient, getDaemon } from '@epicenter/workspace/node';
import { cmd } from '../util/cmd.js';
import { epicenterRootOption } from '../util/common-options.js';
import {
	fail,
	formatOptions,
	type OutputFormat,
	output,
} from '../util/format-output.js';
import { parseJsonInput, readStdin } from '../util/parse-input.js';

/** Dialing spawns a child + MCP handshake on the remote, so allow more than the
 * daemon client's 5s default; must exceed the gateway catalog's connect timeout
 * so a refusal surfaces as the daemon's DialFailed, not a client Timeout. */
const DIAL_TIMEOUT_MS = 20_000;

/** The default route a bare `epicenter tools <device>` lists. */
const DEFAULT_ROUTE = 'books';

export const toolsCommand = cmd({
	command: 'tools <device>',
	describe: "List a verified device's MCP tools for one route (default: books)",
	builder: (yargs) =>
		yargs
			.positional('device', {
				type: 'string',
				demandOption: true,
				describe: "Target device: nodeId (shown in the target's daemon up log)",
			})
			.option('route', {
				type: 'string',
				default: DEFAULT_ROUTE,
				describe: 'Named route on the target gateway',
			})
			.option('addr', {
				type: 'string',
				array: true,
				describe:
					'Optional ip:port dial hint(s); n0 discovery finds the peer by id without them (repeatable)',
			})
			.option('C', epicenterRootOption)
			.options(formatOptions)
			.strict(),
	handler: async (argv) => {
		const { data: daemon, error: daemonErr } = await getDaemon(
			argv.C,
			DIAL_TIMEOUT_MS,
		);
		if (daemonErr) {
			fail(daemonErr.message);
			return;
		}

		const device = await resolveDevice(daemon, argv.device);
		if (device === null) return;

		const { data, error } = await daemon.tools({
			device,
			route: argv.route,
			hintAddrs: argv.addr,
		});
		if (error) {
			fail(error.message);
			return;
		}
		emitTools(data, argv.format);
	},
});

export const callCommand = cmd({
	command: 'call <device> <route> <tool> [input]',
	describe: "Call one MCP tool on a verified device's route",
	builder: (yargs) =>
		yargs
			.positional('device', {
				type: 'string',
				demandOption: true,
				describe: "Target device: nodeId (shown in the target's daemon up log)",
			})
			.positional('route', {
				type: 'string',
				demandOption: true,
				describe: 'Named route on the target gateway, e.g. books',
			})
			.positional('tool', {
				type: 'string',
				demandOption: true,
				describe: 'Tool name (see `epicenter tools <device>`)',
			})
			.positional('input', {
				type: 'string',
				describe: 'Inline JSON or @file.json (else stdin)',
			})
			.option('addr', {
				type: 'string',
				array: true,
				describe:
					'Optional ip:port dial hint(s); n0 discovery finds the peer by id without them (repeatable)',
			})
			.option('C', epicenterRootOption)
			.options(formatOptions)
			.strict(),
	handler: async (argv) => {
		const input = await resolveInput(argv.input);

		const { data: daemon, error: daemonErr } = await getDaemon(
			argv.C,
			DIAL_TIMEOUT_MS,
		);
		if (daemonErr) {
			fail(daemonErr.message);
			return;
		}

		const device = await resolveDevice(daemon, argv.device);
		if (device === null) return;

		const { data, error } = await daemon.call({
			device,
			route: argv.route,
			tool: argv.tool,
			// MCP arguments are an object; an absent input means no arguments.
			input: input ?? {},
			hintAddrs: argv.addr,
		});
		if (error) {
			fail(error.message);
			return;
		}
		// A tool that ran but returned an error is exit 2 (runtime), distinct from a
		// dial/usage failure (exit 1): the loop reached the tool and it said no.
		if (data.isError) {
			fail(stringifyOutput(data.output), { code: 2 });
			return;
		}
		if (argv.format === 'json' || argv.format === 'jsonl') {
			output(data.output, { format: argv.format });
			return;
		}
		process.stdout.write(`${stringifyOutput(data.output)}\n`);
	},
});

/**
 * Resolve a `<device>` token to a dial target (a nodeId) against the relay
 * floor's live presence. Accepts the exact nodeId of a device currently online
 * on the relay; on a miss prints the online devices and returns `null` (the
 * caller stops). This is the target-device-first picker: you dial a device that
 * is online, addressed by its nodeId, never an enrolled-but-offline one.
 */
async function resolveDevice(
	daemon: DaemonClient,
	token: string,
): Promise<string | null> {
	const { data: rows, error } = await daemon.relayPeers();
	if (error) {
		fail(error.message);
		return null;
	}

	const match = rows.find((row) => row.nodeId === token);
	if (match) return match.nodeId;

	fail(`no device "${token}" online on the relay`, {
		details:
			rows.length === 0
				? ['no other devices are online (run `epicenter daemon up` on the target, signed in)']
				: ['online devices:', ...rows.map((row) => `  ${row.nodeId}`)],
	});
	return null;
}

function emitTools(
	tools: Array<{ name: string; title?: string; description?: string; kind: string }>,
	format: OutputFormat | undefined,
): void {
	if (format === 'json' || format === 'jsonl') {
		output(tools, { format });
		return;
	}
	if (tools.length === 0) {
		console.error('no tools');
		return;
	}
	console.table(
		tools.map((tool) => ({
			name: tool.name,
			kind: tool.kind,
			description: tool.title ?? tool.description ?? '',
		})),
	);
}

/** Render a tool outcome for text mode: a string passes through, else JSON. */
function stringifyOutput(value: unknown): string {
	return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

async function resolveInput(input: string | undefined): Promise<unknown> {
	const positional = input && input.length > 0 ? input : undefined;
	const stdinContent = await readStdin();
	return parseJsonInput({ positional, stdinContent });
}
