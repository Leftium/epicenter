/**
 * `epicenter list [dot.path]` — render exposed actions, locally or on a peer.
 *
 * Three sources, one renderer. Default reads the local workspace's action
 * tree; `--peer <deviceId>` reads from a connected peer's awareness; `--all`
 * fans out across self and every connected peer in one invocation.
 *
 * Modes:
 *   1. No path                → full tree for the chosen source(s).
 *   2. Partial dotted path    → subtree under that prefix.
 *   3. Leaf (action) path     → action detail with JSON input shape.
 *
 * Output:
 *   - Default: ASCII tree (human)
 *   - `--format json`: flat array of `{ path, type, description?, input? }`.
 *     With `--all`, each row also carries a `peer` field naming the source.
 *
 * The published manifest (`device.offers` on awareness) is structurally
 * `Record<dotPath, ActionMeta>`, so the renderer is the same regardless of
 * whether the entries came from a local walk or a remote peer's awareness
 * state.
 */

import type { ActionMeta, Actions } from '@epicenter/workspace';
import Type, { type TSchema } from 'typebox';
import type { Argv, CommandModule, Options } from 'yargs';
import {
	loadConfig,
	type LoadConfigResult,
	type LoadedWorkspace,
} from '../load-config';
import { type AwarenessState, readPeers } from '../util/awareness';
import {
	dirFromArgv,
	dirOption,
	workspaceFromArgv,
	workspaceOption,
} from '../util/common-options';
import { findPeer } from '../util/find-peer';
import {
	formatYargsOptions,
	output,
	outputError,
} from '../util/format-output';
import { resolveEntry } from '../util/resolve-entry';
import { walkActions } from '../util/walk-actions';

const POLL_INTERVAL_MS = 100;
const DEFAULT_WAIT_MS = 500;

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
	describe: 'Tree view of exposed queries and mutations (use --peer or --all to inspect remotely)',
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
		const pathArg = typeof args.path === 'string' ? args.path : undefined;
		const format = args.format as 'json' | 'jsonl' | undefined;
		const peerTarget =
			typeof args.peer === 'string' && args.peer.length > 0
				? args.peer
				: undefined;
		const all = args.all === true;
		const waitMs = typeof args.wait === 'number' ? args.wait : DEFAULT_WAIT_MS;

		if (peerTarget !== undefined && all) {
			outputError(
				'error: --peer and --all are mutually exclusive (--all already includes every peer)',
			);
			process.exitCode = 1;
			return;
		}

		const { entries, dispose } = await loadConfig(dirFromArgv(args));
		try {
			const entry = resolveEntry(entries, workspaceFromArgv(args));
			if (peerTarget !== undefined && peerTarget !== 'self') {
				await renderPeer(entry, peerTarget, pathArg, waitMs, format);
				return;
			}
			if (all) {
				await renderAll(entry, pathArg, waitMs, format);
				return;
			}
			renderLocal(entry, pathArg, format);
		} finally {
			await dispose();
		}
	},
};

// ─── Source helpers (pure) ───────────────────────────────────────────────────

/** Walk a local actions tree into a flat dot-path map of metadata. */
export function sourceLocal(actions: Actions | undefined): Map<string, ActionMeta> {
	const out = new Map<string, ActionMeta>();
	if (!actions) return out;
	for (const [path, action] of walkActions(actions)) {
		out.set(path, action);
	}
	return out;
}

/** Read a single peer's `device.offers` manifest from its awareness state. */
export function sourcePeer(state: AwarenessState): Map<string, ActionMeta> {
	const offers = (state.device as { offers?: Record<string, ActionMeta> } | undefined)
		?.offers;
	const out = new Map<string, ActionMeta>();
	if (!offers) return out;
	for (const [path, entry] of Object.entries(offers)) {
		out.set(path, entry);
	}
	return out;
}

/**
 * Self plus every connected peer. Self is always first. Peers follow in
 * clientID-ascending order so the same workspace renders deterministically
 * across runs (mirrors `buildPeerRows` ordering).
 */
export type AllSection = {
	label: string;
	peer: string;
	entries: Map<string, ActionMeta>;
};

export function sourceAll(workspace: LoadedWorkspace): AllSection[] {
	const sections: AllSection[] = [
		{
			label: 'self (this device)',
			peer: 'self',
			entries: sourceLocal(workspace.actions),
		},
	];
	const peers = readPeers(workspace);
	const ordered = [...peers.entries()].sort(([a], [b]) => a - b);
	for (const [clientID, state] of ordered) {
		const device = state.device as
			| { id?: string; name?: string }
			| undefined;
		const name = device?.name ?? device?.id ?? `clientID ${clientID}`;
		const entries = sourcePeer(state);
		const suffix = entries.size === 0 ? ' (online, offers: 0)' : ' (online)';
		sections.push({
			label: `${name}${suffix}`,
			peer: device?.id ?? `clientID:${clientID}`,
			entries,
		});
	}
	return sections;
}

// ─── Local mode ──────────────────────────────────────────────────────────────

function renderLocal(
	entry: LoadConfigResult['entries'][number],
	pathArg: string | undefined,
	format: 'json' | 'jsonl' | undefined,
): void {
	const entries = sourceLocal(entry.workspace.actions);
	renderSection(entries, pathArg, entry.name, format);
}

function renderSection(
	entries: Map<string, ActionMeta>,
	pathArg: string | undefined,
	label: string,
	format: 'json' | 'jsonl' | undefined,
): void {
	const path = pathArg?.split('.').filter(Boolean).join('.') ?? '';

	if (path === '') {
		const all = [...entries].map(([p, a]) => describeAction(a, p));
		if (format) {
			output(all, { format });
			return;
		}
		console.log(label);
		printTree(entries, '');
		return;
	}

	const action = entries.get(path);
	if (action) {
		if (format) {
			output(describeAction(action, path), { format });
			return;
		}
		printActionDetail(path, action);
		return;
	}

	const descendants = entriesUnder(entries, path);
	if (descendants.size === 0) {
		outputError(`"${pathArg}" is not defined.`);
		throw new Error('Path not found');
	}

	if (format) {
		output(
			[...descendants].map(([p, a]) => describeAction(a, p)),
			{ format },
		);
		return;
	}
	console.log(path);
	printTree(entries, path);
}

// ─── Remote single-peer mode ─────────────────────────────────────────────────

async function renderPeer(
	entry: LoadConfigResult['entries'][number],
	peerTarget: string,
	pathArg: string | undefined,
	waitMs: number,
	format: 'json' | 'jsonl' | undefined,
): Promise<void> {
	const { workspace } = entry;
	if (workspace.sync?.whenConnected) await workspace.sync.whenConnected;

	const deadline = Date.now() + waitMs;
	let state: AwarenessState | undefined;
	while (true) {
		const peers = readPeers(workspace);
		const found = findPeer(peerTarget, peers);
		if (found.kind === 'found') {
			state = found.state;
			break;
		}
		if (Date.now() >= deadline) break;
		await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
	}

	if (!state) {
		outputError(`error: no peer matches deviceId "${peerTarget}"`);
		outputError('run `epicenter peers` to see connected peers');
		process.exitCode = 3;
		return;
	}

	const entries = sourcePeer(state);
	const device = state.device as { name?: string; id?: string } | undefined;
	const label = device?.name ?? device?.id ?? peerTarget;
	renderSection(entries, pathArg, label, format);
}

// ─── --all mode ──────────────────────────────────────────────────────────────

async function renderAll(
	entry: LoadConfigResult['entries'][number],
	pathArg: string | undefined,
	waitMs: number,
	format: 'json' | 'jsonl' | undefined,
): Promise<void> {
	const { workspace } = entry;
	if (workspace.sync?.whenConnected) await workspace.sync.whenConnected;

	// Poll for peers up to the deadline. Self is always present, so we wait
	// only to give awareness a chance to populate.
	const deadline = Date.now() + waitMs;
	while (true) {
		if (readPeers(workspace).size > 0 || Date.now() >= deadline) break;
		await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
	}

	const sections = sourceAll(workspace);
	const path = pathArg?.split('.').filter(Boolean).join('.') ?? '';

	if (format) {
		const rows: Array<{ peer: string } & ReturnType<typeof describeAction>> = [];
		for (const section of sections) {
			const subset = path ? filterToPathOrUnder(section.entries, path) : section.entries;
			for (const [p, a] of subset) {
				rows.push({ peer: section.peer, ...describeAction(a, p) });
			}
		}
		if (path && rows.length === 0) {
			outputError(`error: "${pathArg}" not found on any peer`);
			process.exitCode = 1;
			return;
		}
		output(rows, { format });
		return;
	}

	let anyMatch = false;
	for (let i = 0; i < sections.length; i++) {
		const section = sections[i]!;
		const subset = path ? filterToPathOrUnder(section.entries, path) : section.entries;
		if (path && subset.size === 0) continue;
		anyMatch = true;
		if (i > 0) console.log('');
		console.log(section.label);
		if (subset.size === 0) continue;
		// When path resolves to a single leaf on this peer, print detail; else tree.
		const leaf = path ? subset.get(path) : undefined;
		if (leaf && subset.size === 1) {
			printActionDetail(path, leaf);
		} else {
			printTree(subset, path);
		}
	}
	if (path && !anyMatch) {
		outputError(`error: "${pathArg}" not found on any peer`);
		process.exitCode = 1;
	}
}

function filterToPathOrUnder(
	entries: Map<string, ActionMeta>,
	path: string,
): Map<string, ActionMeta> {
	const pfx = path + '.';
	const out = new Map<string, ActionMeta>();
	for (const [p, a] of entries) {
		if (p === path || p.startsWith(pfx)) out.set(p, a);
	}
	return out;
}

function entriesUnder(
	entries: Map<string, ActionMeta>,
	prefix: string,
): Map<string, ActionMeta> {
	if (!prefix) return entries;
	return filterToPathOrUnder(entries, prefix);
}

// ─── Renderer (source-agnostic; reads metadata only) ─────────────────────────

type ActionDescriptor = {
	path: string;
	type: string;
	description?: string;
	input?: unknown;
};

function describeAction(action: ActionMeta, path: string): ActionDescriptor {
	const desc: ActionDescriptor = { path, type: action.type };
	if (action.description) desc.description = action.description;
	if (action.input) desc.input = action.input;
	return desc;
}

type TreeNode = {
	name: string;
	children: Map<string, TreeNode>;
	action?: ActionMeta;
};

function printTree(entries: Map<string, ActionMeta>, prefix: string): void {
	const pfx = prefix ? prefix + '.' : '';
	const root: TreeNode = { name: '', children: new Map() };
	let count = 0;
	for (const [path, action] of entries) {
		if (prefix && !path.startsWith(pfx) && path !== prefix) continue;
		const rest = prefix ? path.slice(pfx.length) : path;
		if (!rest) continue;
		const parts = rest.split('.');
		count++;
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
	if (count === 0) {
		console.log('  (no actions exposed)');
		return;
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

function printActionDetail(path: string, action: ActionMeta): void {
	console.log(`${path}  (${action.type})`);
	if (action.description) {
		console.log('');
		console.log(`  ${action.description}`);
	}
	if (action.input) {
		console.log('');
		console.log('  Input fields (pass as JSON):');
		for (const line of describeInput(action.input as TSchema))
			console.log(`    ${line}`);
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
