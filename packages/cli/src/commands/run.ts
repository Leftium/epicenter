/**
 * `epicenter run <action_key> [input]`: invoke a `defineQuery` or
 * `defineMutation` by its bare action key through the local
 * `epicenter daemon up` daemon.
 *
 * `input` is JSON: inline positional, `@file.json` (curl convention), or stdin.
 * The daemon serves one mount, so the action key alone addresses the action;
 * the CLI forwards it to the daemon verbatim, which runs it against its own
 * action registry. Reaching another device's actions is a separate surface
 * (`epicenter tools` / `epicenter call`, the relay-floor MCP routes), not a
 * flag on `run`.
 *
 * `epicenter run` requires a running daemon for the discovered Epicenter root.
 * Without `daemon up`, the handler errors with a hint pointing at
 * `epicenter daemon up`.
 *
 * Exit codes:
 *   1: usage error (unknown action, action input that fails the action's
 *      schema), or no daemon (`Required`, transport error)
 *   2: runtime error (the action returned Err)
 */

import {
	type DaemonError,
	getDaemon,
	type RunError,
} from '@epicenter/workspace/node';
import type { Result } from 'wellcrafted/result';

import { cmd } from '../util/cmd.js';
import { epicenterRootOption } from '../util/common-options.js';
import {
	fail,
	formatOptions,
	type OutputFormat,
	output,
} from '../util/format-output.js';
import { parseJsonInput, readStdin } from '../util/parse-input.js';

export const runCommand = cmd({
	command: 'run <action> [input]',
	describe: 'Invoke a defineQuery / defineMutation by action key',
	builder: (yargs) =>
		yargs
			.positional('action', {
				type: 'string',
				demandOption: true,
				describe: 'Action key, e.g. notes_add',
			})
			.positional('input', {
				type: 'string',
				describe: 'Inline JSON or @file.json',
			})
			.option('C', epicenterRootOption)
			.options(formatOptions)
			.strict(),
	handler: async (argv) => {
		const actionInput = await resolveInput(argv.input);

		const { data: daemon, error: daemonErr } = await getDaemon(argv.C);
		if (daemonErr) {
			fail(daemonErr.message);
			return;
		}

		// One mount per root, so the bare action key is the address. An unknown
		// key surfaces from the daemon's handler as a `UsageError` with sibling
		// suggestions, rendered below.
		const result = await daemon.run({
			actionPath: argv.action,
			input: actionInput,
		});
		renderRunResult(result, argv.format);
	},
});

function renderRunResult(
	result: Result<unknown, RunError | DaemonError>,
	format: OutputFormat | undefined,
): void {
	if (result.error === null) {
		output(result.data, { format });
		return;
	}
	switch (result.error.name) {
		case 'UsageError': {
			const details = result.error.suggestions?.length
				? ['', 'Exposed actions at this key:', ...result.error.suggestions]
				: [];
			fail(result.error.message, { details });
			return;
		}
		case 'RuntimeError':
			fail(result.error.message, { code: 2 });
			return;
		case 'Required':
		case 'Timeout':
		case 'Unreachable':
		case 'HandlerCrashed':
			fail(result.error.message);
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
