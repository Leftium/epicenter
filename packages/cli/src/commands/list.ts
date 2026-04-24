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
import { iterateActions } from '@epicenter/workspace';
import Type, { type TSchema } from 'typebox';
import type { Argv, CommandModule } from 'yargs';
import { loadConfig, type LoadConfigResult } from '../load-config';
import { dirFromArgv, dirOption } from '../util/dir-option';
import {
	formatYargsOptions,
	output,
	outputError,
} from '../util/format-output';
import { resolveEntry } from '../util/resolve-entry';
import { resolvePath } from '../util/resolve-path';
import { workspaceFromArgv, workspaceOption } from '../util/workspace-option';

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

function collectActions(root: unknown, prefix: string[]): ActionDescriptor[] {
	if (root == null || typeof root !== 'object') return [];
	const out: ActionDescriptor[] = [];
	for (const [action, path] of iterateActions(root)) {
		out.push(describeAction(action, [...prefix, ...path].join('.')));
	}
	return out;
}

function render(
	pathArg: string | undefined,
	entry: LoadConfigResult['entries'][number],
	format: 'json' | 'jsonl' | undefined,
): void {
	const segments = pathArg ? pathArg.split('.').filter(Boolean) : [];

	if (segments.length === 0) {
		if (format) {
			output(collectActions(entry.handle, []), { format });
			return;
		}
		console.log(entry.name);
		printTree(entry.handle);
		return;
	}

	const resolved = resolvePath(entry.handle, segments);

	if (resolved.kind === 'missing') {
		outputError(
			`"${pathArg}" is not defined. Stopped at ` +
				`"${resolved.lastGoodPath.join('.')}" ` +
				`while looking for "${resolved.missingSegment}".`,
		);
		throw new Error('Path not found');
	}

	const joinedPath = segments.join('.');

	if (resolved.kind === 'action') {
		if (format) {
			output(describeAction(resolved.action, joinedPath), { format });
			return;
		}
		printActionDetail(joinedPath, resolved.action);
		return;
	}

	if (format) {
		output(collectActions(resolved.node, segments), { format });
		return;
	}
	console.log(joinedPath);
	printTree(resolved.node);
}

// ─── Rendering ───────────────────────────────────────────────────────────────

type TreeNode = { name: string; children: Map<string, TreeNode>; action?: Action };

function printTree(root: unknown): void {
	if (root == null || typeof root !== 'object') {
		console.log('  (no actions exposed)');
		return;
	}
	const tree: TreeNode = { name: '', children: new Map() };
	let count = 0;
	for (const [action, path] of iterateActions(root)) {
		count++;
		let node = tree;
		for (let i = 0; i < path.length; i++) {
			const seg = path[i]!;
			let child = node.children.get(seg);
			if (!child) {
				child = { name: seg, children: new Map() };
				node.children.set(seg, child);
			}
			node = child;
			if (i === path.length - 1) node.action = action;
		}
	}
	if (count === 0) {
		console.log('  (no actions exposed)');
		return;
	}
	printChildren(tree, '');
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
