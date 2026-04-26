/**
 * `epicenter list [dot.path]` — render a tree of runnable actions.
 *
 * Three modes:
 *   1. No argument         → full tree for the resolved workspace entry.
 *   2. Partial path        → subtree under that path.
 *   3. Leaf (action) path  → action detail with JSON input shape.
 *
 * Output:
 *   - Default: ASCII tree (human)
 *   - `--format json`: flat array of `{ path, type, description?, input? }`
 *     so scripts can filter/iterate actions without parsing tree art. For
 *     a leaf path, emits a single descriptor object.
 */

import type { Action } from '@epicenter/workspace';
import Type, { type TSchema } from 'typebox';
import type { Argv, CommandModule } from 'yargs';
import { loadConfig, type LoadConfigResult } from '../load-config';
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
import { actionsUnder, findAction, walkActions } from '../util/walk-actions';

export const listCommand: CommandModule = {
	command: 'list [path]',
	describe: 'Tree view of exposed queries and mutations',
	builder: (yargs: Argv) =>
		yargs
			.positional('path', {
				type: 'string',
				describe: 'Optional dot-path to narrow the view',
			})
			.option('dir', dirOption)
			.option('workspace', workspaceOption)
			.options(formatYargsOptions()),
	handler: async (argv) => {
		const args = argv as Record<string, unknown>;
		const path = typeof args.path === 'string' ? args.path : undefined;
		const format = args.format as 'json' | 'jsonl' | undefined;
		const { entries, dispose } = await loadConfig(dirFromArgv(args));
		try {
			const entry = resolveEntry(entries, workspaceFromArgv(args));
			render(path, entry, format);
		} finally {
			await dispose();
		}
	},
};

type ActionDescriptor = {
	path: string;
	type: string;
	description?: string;
	input?: unknown;
};

function describeAction(action: Action, path: string): ActionDescriptor {
	const desc: ActionDescriptor = { path, type: action.type };
	if (action.description) desc.description = action.description;
	if (action.input) desc.input = action.input;
	return desc;
}

function render(
	pathArg: string | undefined,
	entry: LoadConfigResult['entries'][number],
	format: 'json' | 'jsonl' | undefined,
): void {
	const { workspace } = entry;
	const path = pathArg?.split('.').filter(Boolean).join('.') ?? '';

	if (path === '') {
		const all = [...walkActions(workspace.actions)].map(([p, a]) =>
			describeAction(a, p),
		);
		if (format) {
			output(all, { format });
			return;
		}
		console.log(entry.name);
		printTree(workspace.actions, '');
		return;
	}

	const action = findAction(workspace.actions, path);
	if (action) {
		if (format) {
			output(describeAction(action, path), { format });
			return;
		}
		printActionDetail(path, action);
		return;
	}

	const descendants = actionsUnder(workspace.actions, path);
	if (descendants.length === 0) {
		outputError(`"${pathArg}" is not defined.`);
		throw new Error('Path not found');
	}

	if (format) {
		output(
			descendants.map(([p, a]) => describeAction(a, p)),
			{ format },
		);
		return;
	}
	console.log(path);
	printTree(workspace.actions, path);
}

// ─── Rendering ───────────────────────────────────────────────────────────────

type TreeNode = { name: string; children: Map<string, TreeNode>; action?: Action };

function printTree(actions: unknown, prefix: string): void {
	const pfx = prefix ? prefix + '.' : '';
	const root: TreeNode = { name: '', children: new Map() };
	let count = 0;
	for (const [path, action] of walkActions(actions)) {
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

function printActionDetail(path: string, action: Action): void {
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
