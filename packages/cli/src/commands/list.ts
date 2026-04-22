/**
 * `epicenter list [dot.path]` — render a tree of runnable actions.
 *
 * Three modes:
 *   1. No argument         → group by export name, full tree for each.
 *   2. Partial path        → subtree under that path.
 *   3. Leaf (action) path  → action detail with flag help.
 */

import type { Action } from '@epicenter/workspace';
import { iterateActions } from '@epicenter/workspace';
import Type, { type TSchema } from 'typebox';
import type { Argv, CommandModule } from 'yargs';
import { loadConfig, type LoadConfigResult } from '../load-config';
import { outputError } from '../util/format-output';
import { resolvePath } from '../util/resolve-path';

export const listCommand: CommandModule = {
	command: 'list [path]',
	describe: 'Tree view of exposed queries and mutations',
	builder: (yargs: Argv) =>
		yargs
			.positional('path', {
				type: 'string',
				describe: 'Optional dot-path to narrow the view',
			})
			.option('dir', {
				type: 'string',
				alias: 'C',
				default: '.',
				description: 'Directory containing epicenter.config.ts',
			}),
	handler: async (argv) => {
		const path = typeof argv.path === 'string' ? argv.path : undefined;
		const dir = typeof argv.dir === 'string' ? argv.dir : '.';
		const { entries, dispose } = await loadConfig(dir);
		try {
			render(path, entries);
		} finally {
			await dispose();
		}
	},
};

function render(
	pathArg: string | undefined,
	entries: LoadConfigResult['entries'],
): void {
	const segments = pathArg ? pathArg.split('.').filter(Boolean) : [];

	if (segments.length === 0) {
		entries.forEach((entry, i) => {
			if (i > 0) console.log('');
			console.log(entry.name);
			printTree(entry.handle);
		});
		return;
	}

	const exportName = segments[0]!;
	const rest = segments.slice(1);
	const entry = entries.find((e) => e.name === exportName);
	if (!entry) {
		outputError(
			`No export named "${exportName}" in epicenter.config.ts. ` +
				`Available: ${entries.map((e) => e.name).join(', ')}`,
		);
		throw new Error('Export not found');
	}

	const resolved = resolvePath(entry.handle, rest);

	if (resolved.kind === 'missing') {
		outputError(
			`"${pathArg}" is not defined. Stopped at ` +
				`"${[exportName, ...resolved.lastGoodPath].join('.')}" ` +
				`while looking for "${resolved.missingSegment}".`,
		);
		throw new Error('Path not found');
	}

	if (resolved.kind === 'action') {
		printActionDetail(segments.join('.'), resolved.action);
		return;
	}

	console.log(segments.join('.'));
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
		console.log('  Arguments:');
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
		lines.push(`--${key} <${typeLabel}>  ${req}${desc}`);
	}
	return lines;
}
