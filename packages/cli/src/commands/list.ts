/**
 * `epicenter list [dot.path]` — render exposed actions, locally or on a peer.
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
 * of `Section`s (one or many) and prints text or JSON; sources are pure
 * functions that produce sections — that's the whole flow.
 *
 * Peer manifests are fetched once per invocation via
 * `peerSystem(sync, deviceId).describe()` — awareness no longer carries
 * action manifests, so detail-mode renders from the same fetched object
 * as tree-mode (no second RTT).
 */

import {
	type ActionManifest,
	describeActions,
	peerSystem,
	type SyncAttachment,
} from '@epicenter/workspace';
import Type, { type TSchema } from 'typebox';
import type { Argv, CommandModule, Options } from 'yargs';
import {
	type AwarenessState,
	loadConfig,
	type WorkspaceEntry,
} from '../load-config';
import { waitForAnyPeer, waitForPeer } from '../util/peer-wait';
import {
	dirFromArgv,
	dirOption,
	workspaceFromArgv,
	workspaceOption,
} from '../util/common-options';
import {
	formatYargsOptions,
	output,
	outputError,
} from '../util/format-output';
import { resolveEntry } from '../util/resolve-entry';

const DEFAULT_WAIT_MS = 500;

type Format = 'json' | 'jsonl' | undefined;

/**
 * One section to render. `peer` is `'self'` for the local source or the
 * remote peer's deviceId — surfaced in JSON output so scripts can
 * attribute each action back to its source.
 *
 * `unavailableReason` is set when the peer's manifest fetch failed; the
 * detail/tree renderer surfaces it as a "schema unavailable" footer
 * instead of crashing on a transient RPC failure.
 */
type Section = {
	label: string;
	peer: string;
	entries: ActionManifest;
	unavailableReason?: string;
};

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

		await using config = await loadConfig(dirFromArgv(args));
		const entry = resolveEntry(config.entries, workspaceFromArgv(args));
		const sections = await selectSections(entry, { peerTarget, all, waitMs });
		if (sections === null) return; // peer-not-found, exitCode already set
		await renderSections(sections, path, format, { multi: all });
	},
};

// ─── Source selection ────────────────────────────────────────────────────────

type Selection = {
	peerTarget: string | undefined;
	all: boolean;
	waitMs: number;
};

/**
 * Pick the sections to render based on flags. Returns `null` when a
 * `--peer` lookup misses (the function emits the error and sets the exit
 * code; the caller just bails).
 */
async function selectSections(
	entry: WorkspaceEntry,
	{ peerTarget, all, waitMs }: Selection,
): Promise<Section[] | null> {
	const { workspace } = entry;

	if (peerTarget === undefined && !all) {
		return [selfSection(entry, 'local')];
	}

	const deadline = Date.now() + waitMs;
	if (peerTarget !== undefined) {
		const found = await waitForPeer(workspace, peerTarget, deadline);
		if (found.kind !== 'found') {
			outputError(`error: no peer matches deviceId "${peerTarget}"`);
			outputError('run `epicenter peers` to see connected peers');
			process.exitCode = 3;
			return null;
		}
		return [await peerSection(found.state, workspace.sync)];
	}

	// --all: best-effort wait for awareness to populate, then snapshot.
	await waitForAnyPeer(workspace, deadline);
	const peers = workspace.sync?.peers() ?? new Map<number, AwarenessState>();
	const ordered = [...peers.entries()].sort(([a], [b]) => a - b);
	const sections: Section[] = [selfSection(entry, 'all')];
	for (const [, state] of ordered) {
		sections.push(await peerSection(state, workspace.sync));
	}
	return sections;
}

export function selfSection(
	entry: WorkspaceEntry,
	mode: 'local' | 'all',
): Section {
	const localActions = entry.workspace.actions;
	const entries = localActions ? describeActions(localActions) : {};
	return {
		label: mode === 'all' ? 'self (this device)' : entry.name,
		peer: 'self',
		entries,
	};
}

export async function peerSection(
	state: AwarenessState,
	sync: SyncAttachment | undefined,
): Promise<Section> {
	const { device } = state;
	if (!sync) {
		return {
			label: `${device.name} (online, schema unavailable)`,
			peer: device.id,
			entries: {},
			unavailableReason: 'no sync attachment',
		};
	}

	const result = await peerSystem(sync, device.id).describe();
	if (result.error) {
		const err = result.error as { name?: string; message?: string };
		const reason = err.message ?? err.name ?? 'unknown error';
		return {
			label: `${device.name} (online, schema unavailable)`,
			peer: device.id,
			entries: {},
			unavailableReason: reason,
		};
	}
	const entries = result.data;
	const suffix =
		Object.keys(entries).length === 0 ? ' (online, no actions)' : ' (online)';
	return {
		label: `${device.name}${suffix}`,
		peer: device.id,
		entries,
	};
}

// ─── Rendering ───────────────────────────────────────────────────────────────

/**
 * `multi` distinguishes `--all` (always tag rows with `peer`, allow zero
 * matches per-section) from local/--peer (single section, missing path is
 * an error). It's a presentation flag, not a structural one — selection
 * already gave us the sections; we just need to know which mode the user
 * asked for.
 */
async function renderSections(
	sections: Section[],
	path: string,
	format: Format,
	{ multi }: { multi: boolean },
): Promise<void> {
	if (format) {
		renderJson(sections, path, format, { multi });
		return;
	}
	await renderText(sections, path, { multi });
}

function renderJson(
	sections: Section[],
	path: string,
	format: Exclude<Format, undefined>,
	{ multi }: { multi: boolean },
): void {
	// Single-section + leaf path = single object (preserves pre-existing
	// `list <leaf> --format json` shape).
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
	{ multi }: { multi: boolean },
): Promise<void> {
	let totalMatches = 0;
	let printed = 0;

	for (const section of sections) {
		const subset = filterByPath(section.entries, path);
		const matches = Object.keys(subset).length;
		totalMatches += matches;

		// Skip sections with no entries matching the requested path. In
		// single-section mode the totalMatches==0 fail below speaks for
		// itself, with no noisy "(no actions exposed)" preamble.
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

/**
 * Print one section's body. Three cases: empty, exact-leaf detail, tree.
 * The caller has already filtered to entries under `path` (if set).
 */
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

// ─── Pure helpers ────────────────────────────────────────────────────────────

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

// ─── Renderer primitives (text mode) ─────────────────────────────────────────

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

