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
 * `describePeer(sync, deviceId)` — awareness no longer carries action
 * manifests, so detail-mode renders from the same fetched object as
 * tree-mode (no second RTT).
 *
 * ## Auto-detect (Wave 6)
 *
 * When an `epicenter up` daemon is running for the same `--dir`, the
 * yargs handler short-circuits through {@link ipcCall} and asks the
 * daemon to run {@link listCore} against its already-warm workspace.
 * The same {@link ListResult} shape flows out either path so the
 * renderer doesn't care which side built it.
 */

import {
	type ActionManifest,
	describeActions,
	describePeer,
	type SyncAttachment,
} from '@epicenter/workspace';
import Type, { type TSchema } from 'typebox';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import type { Argv, CommandModule, Options } from 'yargs';
import { ipcCall, ipcPing } from '../daemon/ipc-client';
import { readMetadata } from '../daemon/metadata';
import { socketPathFor } from '../daemon/paths';
import {
	type AwarenessState,
	loadConfig,
	type WorkspaceEntry,
} from '../load-config';
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
import { explainEmpty, waitForAnyPeer, waitForPeer } from '../util/peer-wait';
import { resolveEntry } from '../util/resolve-entry';
import { resolve } from 'node:path';

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

// ─── Mode ────────────────────────────────────────────────────────────────────

export type ListMode =
	| { kind: 'local' }
	| { kind: 'peer'; deviceId: string }
	| { kind: 'all' };

/**
 * Parsed inputs for {@link listCore}. Built by the yargs handler from
 * argv (local path) or by the IPC dispatcher from the wire `args`
 * (daemon path). The shape is identical so both paths feed the same
 * pure function.
 */
export type ListCtx = {
	path: string;
	mode: ListMode;
	waitMs: number;
};

/**
 * Domain errors returned by {@link listCore}. `PeerMiss` is the only failure
 * path that survives across IPC — translated to stderr + exitCode=3 by the
 * renderer on either side of the wire.
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

/**
 * Success payload for {@link listCore}. `sections` is the list the
 * text/JSON renderers consume; `mode` is preserved so the renderer can
 * tell single-source from `--all`.
 */
export type ListSuccess = { sections: Section[]; mode: ListMode };

/** {@link listCore}'s return type — `Result` with the {@link ListError} union. */
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

const noUpOption: Options = {
	type: 'boolean',
	default: false,
	description:
		'Skip the `epicenter up` daemon if one is running and use a transient connection instead',
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
			.option('no-up', noUpOption)
			.options(formatYargsOptions()),
	handler: async (argv) => {
		const args = argv as Record<string, unknown>;
		const path = typeof args.path === 'string' ? args.path : '';
		const format = args.format as Format;
		const waitMs = typeof args.wait === 'number' ? args.wait : DEFAULT_WAIT_MS;
		const noUp = args['no-up'] === true;
		const userWorkspace = workspaceFromArgv(args);

		const mode = parseMode(args);
		if (mode === null) return; // mutex error, exitCode already set

		// Auto-detect path: if a daemon is alive for this dir, dispatch through
		// it instead of bringing up a transient peer of our own.
		if (!noUp) {
			const absDir = resolve(dirFromArgv(args));
			const sock = socketPathFor(absDir);
			if (await ipcPing(sock)) {
				const inherited = inheritWorkspace(absDir, userWorkspace);
				if (inherited === 'mismatch') return; // exitCode already set
				const ctx: ListCtx = { path, mode, waitMs };
				const reply = await ipcCall<ListResult>(sock, 'list', ctx);
				if (reply.error === null) {
					await renderResult(reply.data, path, format);
					return;
				}
				outputError(`error: ${reply.error.message}`);
				process.exitCode = 1;
				return;
			}
		}

		// Fallback: load config in-process and run listCore directly.
		await using config = await loadConfig(dirFromArgv(args));
		const entry = resolveEntry(config.entries, userWorkspace);
		const result = await listCore(entry, { path, mode, waitMs });
		await renderResult(result, path, format);
	},
};

/**
 * Pure core: take a resolved {@link WorkspaceEntry} + parsed {@link ListCtx}
 * and produce the {@link ListResult} the renderer wants. No yargs, no
 * config loading, no rendering — so the daemon's IPC handler can call
 * this against its own already-warm `entry`.
 */
export async function listCore(
	entry: WorkspaceEntry,
	ctx: ListCtx,
): Promise<ListResult> {
	const { workspace } = entry;
	const { mode, waitMs } = ctx;

	if (mode.kind === 'local') {
		return {
			data: { sections: [selfSection(entry, 'local')], mode },
			error: null,
		};
	}

	const deadline = Date.now() + waitMs;
	if (mode.kind === 'peer') {
		const { hit } = await waitForPeer(workspace, mode.deviceId, deadline);
		if (!hit) {
			return ListError.PeerMiss({
				deviceId: mode.deviceId,
				emptyReason: explainEmpty(workspace),
			});
		}
		return {
			data: {
				sections: [await peerSection(hit.state, workspace.sync!)],
				mode,
			},
			error: null,
		};
	}

	// --all
	await waitForAnyPeer(workspace, deadline);
	if (!workspace.sync) {
		return {
			data: { sections: [selfSection(entry, 'all')], mode },
			error: null,
		};
	}
	const ordered = [...workspace.sync.peers().entries()].sort(([a], [b]) => a - b);
	const sections: Section[] = [selfSection(entry, 'all')];
	for (const [, state] of ordered) {
		sections.push(await peerSection(state, workspace.sync));
	}
	return { data: { sections, mode }, error: null };
}

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

/**
 * Workspace inheritance for sibling commands hitting a running daemon
 * (Invariant 7). The daemon owns the entry it was started with; if the
 * user passed a conflicting `--workspace`, refuse rather than silently
 * dispatch to the wrong one.
 *
 * Returns `'mismatch'` after setting exitCode=1 + emitting the literal
 * spec message; otherwise returns the daemon's workspace name (which
 * the IPC handler doesn't actually need — but we still validate, so
 * the user gets the same error in either case).
 */
export function inheritWorkspace(
	absDir: string,
	userWorkspace: string | undefined,
): string | undefined | 'mismatch' {
	const meta = readMetadata(absDir);
	if (!meta) return userWorkspace; // daemon raced away; fall back to user's value
	if (userWorkspace === undefined) return meta.workspace;
	if (userWorkspace !== meta.workspace) {
		outputError(
			`workspace mismatch: daemon owns '${meta.workspace}', requested '${userWorkspace}' — restart the daemon or omit --workspace`,
		);
		process.exitCode = 1;
		return 'mismatch';
	}
	return userWorkspace;
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
	sync: SyncAttachment,
): Promise<Section> {
	const { device } = state;
	const result = await describePeer(sync, device.id);
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
 * Surface either path's {@link ListResult} to the user. `peerMiss` sets
 * exitCode=3 + writes the same multi-line stderr block the in-process
 * path used to emit inline.
 */
async function renderResult(
	result: ListResult,
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
	multi: boolean,
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
