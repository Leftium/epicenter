/**
 * `epicenter list [dot.path]`: render exposed actions, locally or on a peer.
 *
 * Three sources, one shape, one renderer.
 *
 *   list                       local tree (default; no network)
 *   list <path>                local subtree or leaf detail
 *   list --peer <deviceId>     that peer's tree (or detail with <path>)
 *   list --all                 self + every connected peer
 *   list --all <path>          who offers it?
 *
 * `--peer` and `--all` are mutually exclusive. The renderer takes a list
 * of `Section`s (one or many) and prints text or JSON; the daemon's
 * `/list` route produces the sections, and that's the whole flow.
 *
 * `epicenter list` requires a running daemon for the resolved `--dir`.
 * Without `up`, the handler errors with a hint pointing at `epicenter up`.
 */

import { type ActionManifest } from '@epicenter/workspace';
import Type, { type TSchema } from 'typebox';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import type { Argv, CommandModule, Options } from 'yargs';

import { type DaemonError, getDaemon } from '../daemon/client';
import {
	dirOption,
	resolveTarget,
	workspaceOption,
} from '../util/common-options';
import {
	formatYargsOptions,
	output,
	outputError,
} from '../util/format-output';

const DEFAULT_WAIT_MS = 500;

type Format = 'json' | 'jsonl' | undefined;

/**
 * One section to render. `peer` is `'self'` for the local source or the
 * remote peer's deviceId, surfaced in JSON output so scripts can
 * attribute each action back to its source.
 *
 * `unavailableReason` is set when the peer's manifest fetch failed; the
 * detail/tree renderer surfaces it as a "schema unavailable" footer
 * instead of crashing on a transient RPC failure.
 */
export type Section = {
	label: string;
	peer: string;
	entries: ActionManifest;
	unavailableReason?: string;
};

export type ListMode =
	| { kind: 'local' }
	| { kind: 'peer'; deviceId: string }
	| { kind: 'all' };

/**
 * Domain errors returned by the `/list` route. `PeerMiss` is the only
 * failure path that survives across IPC: translated to stderr +
 * exitCode=3 by the renderer.
 */
export const ListError = defineErrors({
	PeerMiss: ({
		deviceId,
		emptyReason,
	}: {
		deviceId: string;
		emptyReason: string | null;
	}) => ({
		message: `no peer matches deviceId "${deviceId}"${emptyReason ? ` (${emptyReason})` : ''}`,
		deviceId,
		emptyReason,
	}),
});
export type ListError = InferErrors<typeof ListError>;

export type ListSuccess = { sections: Section[]; mode: ListMode };
export type ListResult = Result<ListSuccess, ListError>;

const peerOption: Options = {
	type: 'string',
	description: 'Read actions from a remote peer by deviceId',
};

const allOption: Options = {
	type: 'boolean',
	description: 'Read self plus every connected peer in one shot',
};

const waitOption: Options = {
	type: 'number',
	default: DEFAULT_WAIT_MS,
	description: `Ms to wait for awareness to populate; only meaningful with --peer/--all (default ${DEFAULT_WAIT_MS})`,
};

export const listCommand: CommandModule = {
	command: 'list [path]',
	describe:
		'Tree view of exposed queries and mutations (use --peer or --all to inspect remotely)',
	builder: (yargs: Argv) =>
		yargs
			.positional('path', {
				type: 'string',
				describe: 'Optional dot-path to narrow the view',
			})
			.option('dir', dirOption)
			.option('workspace', workspaceOption)
			.option('peer', peerOption)
			.option('all', allOption)
			.option('wait', waitOption)
			.options(formatYargsOptions()),
	handler: async (argv) => {
		const args = argv as Record<string, unknown>;
		const path = typeof args.path === 'string' ? args.path : '';
		const format = args.format as Format;
		const waitMs = typeof args.wait === 'number' ? args.wait : DEFAULT_WAIT_MS;
		const target = resolveTarget(args);

		const mode = parseMode(args);
		if (mode === null) return;

		const { data: daemon, error: daemonErr } = await getDaemon(target);
		if (daemonErr) {
			outputError(daemonErr.message);
			process.exitCode = 1;
			return;
		}
		const result = await daemon.list({
			path,
			mode,
			waitMs,
			workspace: target.userWorkspace,
		});
		await renderResult(result, path, format);
	},
};

function parseMode(args: Record<string, unknown>): ListMode | null {
	const peerTarget =
		typeof args.peer === 'string' && args.peer.length > 0 ? args.peer : undefined;
	const all = args.all === true;
	if (peerTarget !== undefined && all) {
		outputError(
			'error: --peer and --all are mutually exclusive (--all already includes every peer)',
		);
		process.exitCode = 1;
		return null;
	}
	if (peerTarget !== undefined) return { kind: 'peer', deviceId: peerTarget };
	if (all) return { kind: 'all' };
	return { kind: 'local' };
}

async function renderResult(
	result: Result<ListSuccess, ListError | DaemonError>,
	path: string,
	format: Format,
): Promise<void> {
	if (result.error !== null) {
		switch (result.error.name) {
			case 'PeerMiss':
				outputError(
					`error: no peer matches deviceId "${result.error.deviceId}"`,
				);
				outputError('run `epicenter peers` to see connected peers');
				if (result.error.emptyReason)
					outputError(`  reason: ${result.error.emptyReason}`);
				process.exitCode = 3;
				return;
			case 'MissingConfig':
			case 'Required':
			case 'Timeout':
			case 'Unreachable':
			case 'HandlerCrashed':
				outputError(result.error.message);
				process.exitCode = 1;
				return;
		}
		return;
	}
	await renderSections(result.data.sections, path, format, result.data.mode);
}

/**
 * `--all` is the only mode that tags rows with `peer` and tolerates zero
 * matches per-section (it can show a partial fan-out). Single-source modes
 * (local/--peer) treat a missing path as an error. We derive that
 * presentation bit from `mode` rather than threading a separate flag.
 */
async function renderSections(
	sections: Section[],
	path: string,
	format: Format,
	mode: ListMode,
): Promise<void> {
	const multi = mode.kind === 'all';
	if (format) {
		renderJson(sections, path, format, multi);
		return;
	}
	await renderText(sections, path, multi);
}

function renderJson(
	sections: Section[],
	path: string,
	format: Exclude<Format, undefined>,
	multi: boolean,
): void {
	if (!multi && path && sections[0]!.entries[path]) {
		output(toActionDescriptor(sections[0]!.entries[path]!, path), { format });
		return;
	}

	const rows: Array<{ peer?: string } & ReturnType<typeof toActionDescriptor>> = [];
	for (const section of sections) {
		const subset = filterByPath(section.entries, path);
		for (const [p, meta] of Object.entries(subset)) {
			const row = toActionDescriptor(meta, p);
			rows.push(multi ? { peer: section.peer, ...row } : row);
		}
	}
	if (path && rows.length === 0) {
		fail(`"${path}" ${multi ? 'not found on any peer' : 'is not defined'}.`);
		return;
	}
	output(rows, { format });
}

async function renderText(
	sections: Section[],
	path: string,
	multi: boolean,
): Promise<void> {
	let totalMatches = 0;
	let printed = 0;

	for (const section of sections) {
		const subset = filterByPath(section.entries, path);
		const matches = Object.keys(subset).length;
		totalMatches += matches;

		if (path && matches === 0 && !section.unavailableReason) continue;

		if (printed > 0) console.log('');
		console.log(section.label);
		await printSection(subset, path, section.unavailableReason);
		printed++;
	}

	if (path && totalMatches === 0) {
		fail(`"${path}" ${multi ? 'not found on any peer' : 'is not defined'}.`);
	}
}

async function printSection(
	entries: ActionManifest,
	path: string,
	unavailableReason: string | undefined,
): Promise<void> {
	const keys = Object.keys(entries);
	if (keys.length === 0) {
		if (unavailableReason) {
			console.log(`  schema unavailable: ${unavailableReason}`);
		} else {
			console.log('  (no actions exposed)');
		}
		return;
	}
	const leaf = path ? entries[path] : undefined;
	if (leaf && keys.length === 1) {
		printActionDetail(path, leaf);
		return;
	}
	printTree(entries, path);
}

function fail(message: string): void {
	outputError(`error: ${message}`);
	process.exitCode = 1;
}

export function filterByPath(entries: ActionManifest, path: string): ActionManifest {
	if (!path) return entries;
	const pfx = path + '.';
	const out: ActionManifest = {};
	for (const [p, meta] of Object.entries(entries)) {
		if (p === path || p.startsWith(pfx)) out[p] = meta;
	}
	return out;
}

type ActionDescriptor = {
	path: string;
	type: string;
	description?: string;
	input?: unknown;
};

function toActionDescriptor(action: ActionManifest[string], path: string): ActionDescriptor {
	const desc: ActionDescriptor = { path, type: action.type };
	if (action.description) desc.description = action.description;
	if (action.input) desc.input = action.input;
	return desc;
}

type TreeNode = {
	name: string;
	children: Map<string, TreeNode>;
	action?: ActionManifest[string];
};

function printTree(entries: ActionManifest, prefix: string): void {
	const pfx = prefix ? prefix + '.' : '';
	const root: TreeNode = { name: '', children: new Map() };
	for (const [path, action] of Object.entries(entries)) {
		const rest = prefix ? path.slice(pfx.length) : path;
		if (!rest) continue;
		const parts = rest.split('.');
		let node = root;
		for (let i = 0; i < parts.length; i++) {
			const seg = parts[i]!;
			let child = node.children.get(seg);
			if (!child) {
				child = { name: seg, children: new Map() };
				node.children.set(seg, child);
			}
			node = child;
			if (i === parts.length - 1) node.action = action;
		}
	}
	printChildren(root, '');
}

function printChildren(node: TreeNode, prefix: string): void {
	const children = [...node.children.values()];
	children.forEach((child, idx) => {
		const isLast = idx === children.length - 1;
		const branch = isLast ? '└── ' : '├── ';
		const label = child.action
			? `${child.name}  (${child.action.type})${
					child.action.description ? `  ${child.action.description}` : ''
				}`
			: child.name;
		console.log(`${prefix}${branch}${label}`);
		if (child.children.size > 0) {
			printChildren(child, prefix + (isLast ? '    ' : '│   '));
		}
	});
}

export function printActionDetail(
	path: string,
	action: ActionManifest[string],
): void {
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
		const f = field as TSchema & { type?: string; description?: string };
		const typeLabel = f.type ?? 'value';
		const req = required.has(key) ? 'required' : 'optional';
		const desc = f.description ? `  ${f.description}` : '';
		lines.push(`${key}: ${typeLabel}  (${req})${desc}`);
	}
	return lines;
}
