/**
 * `epicenter list [action_key]`: render actions exposed by this root.
 *
 * The daemon serves one mount and returns its label plus bare action keys.
 * Under one-mount-per-root the key alone addresses the action, so the CLI
 * renders and filters by the bare key; the mount label is a display header
 * only.
 *
 * Per-peer schema introspection is a script concern. The CLI lists the local
 * daemon's mounted action surface only.
 *
 * `epicenter list` requires a running daemon for the discovered Epicenter root.
 * Without `daemon up`, the handler errors with a hint pointing at
 * `epicenter daemon up`.
 */

import type { ActionManifest } from '@epicenter/workspace';
import {
	type DaemonError,
	type DaemonListSnapshot,
	getDaemon,
} from '@epicenter/workspace/node';
import Type, { type TSchema } from 'typebox';
import type { Result } from 'wellcrafted/result';

import { cmd } from '../util/cmd.js';
import { epicenterRootOption } from '../util/common-options.js';
import {
	fail,
	formatOptions,
	type OutputFormat,
	output,
} from '../util/format-output.js';

export const listCommand = cmd({
	command: 'list [action]',
	describe: 'List exposed queries and mutations on this node',
	builder: (yargs) =>
		yargs
			.positional('action', {
				type: 'string',
				describe: 'Optional action key to show its detail',
			})
			.option('C', epicenterRootOption)
			.options(formatOptions),
	handler: async (argv) => {
		const action = argv.action ?? '';

		const { data: daemon, error: daemonErr } = await getDaemon(argv.C);
		if (daemonErr) {
			fail(daemonErr.message);
			return;
		}
		const result = await daemon.list();
		renderResult(result, action, argv.format);
	},
});

function renderResult(
	result: Result<DaemonListSnapshot, DaemonError>,
	action: string,
	format: OutputFormat | undefined,
): void {
	if (result.error !== null) {
		switch (result.error.name) {
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
	const { mount, actions } = result.data;
	if (format) {
		renderJson(actions, action, format);
		return;
	}
	renderText(mount, actions, action);
}

function renderJson(
	actions: ActionManifest,
	action: string,
	format: OutputFormat,
): void {
	if (action) {
		const meta = actions[action];
		if (!meta) {
			fail(`"${action}" is not defined.`);
			return;
		}
		output(toActionDescriptor(meta, action), { format });
		return;
	}

	const rows = Object.entries(actions).map(([key, meta]) =>
		toActionDescriptor(meta, key),
	);
	output(rows, { format });
}

function renderText(
	mount: string,
	actions: ActionManifest,
	action: string,
): void {
	if (action) {
		const meta = actions[action];
		if (!meta) {
			fail(`"${action}" is not defined.`);
			return;
		}
		printActionDetail(action, meta);
		return;
	}

	if (Object.keys(actions).length === 0) {
		console.error('(no actions exposed)');
		return;
	}
	printActions(mount, actions);
}

type ActionDescriptor = {
	path: string;
	type: string;
	description?: string;
	input?: unknown;
};

function toActionDescriptor(
	action: ActionManifest[string],
	path: string,
): ActionDescriptor {
	const desc: ActionDescriptor = { path, type: action.type };
	if (action.description) desc.description = action.description;
	if (action.input) desc.input = action.input;
	return desc;
}

/**
 * The daemon serves one mount, so render its label as a single header with the
 * bare action keys (snake_case) listed underneath.
 */
function printActions(mount: string, actions: ActionManifest): void {
	console.log(mount);
	for (const [key, action] of Object.entries(actions)) {
		const desc = action.description ? `  ${action.description}` : '';
		console.log(`  ${key}  (${action.type})${desc}`);
	}
}

function printActionDetail(path: string, action: ActionManifest[string]): void {
	console.log(`${path}  (${action.type})`);
	if (action.description) {
		console.log('');
		console.log(`  ${action.description}`);
	}
	if (action.input) {
		console.log('');
		console.log('  Input fields (pass as JSON):');
		for (const line of describeInput(action.input)) console.log(`    ${line}`);
	}
}

function describeInput(schema: TSchema): string[] {
	if (!Type.IsObject(schema)) return ['(non-object input schema)'];
	const required = new Set(schema.required ?? []);
	const lines: string[] = [];
	for (const [key, field] of Object.entries(schema.properties)) {
		const fieldSchema = field as TSchema & {
			type?: string;
			description?: string;
		};
		const typeLabel = fieldSchema.type ?? 'value';
		const req = required.has(key) ? 'required' : 'optional';
		const desc = fieldSchema.description ? `  ${fieldSchema.description}` : '';
		lines.push(`${key}: ${typeLabel}  (${req})${desc}`);
	}
	return lines;
}
