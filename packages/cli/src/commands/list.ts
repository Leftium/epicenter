/**
 * `epicenter list [dot.path]` — render a tree of runnable actions.
 *
 * Three modes:
 *   1. No argument         → group by export name, full tree for each.
 *   2. Partial path        → subtree under that path.
 *   3. Leaf (action) path  → action detail with flag help.
 */

import type { Action } from '@epicenter/workspace';
import Type, { type TSchema } from 'typebox';
import type { Argv, CommandModule } from 'yargs';
import { type ConfigEntry, loadConfig } from '../load-config';
import {
	bundleOf,
	discoverActions,
	resolvePath,
} from '../util/discover-actions';
import { outputError } from '../util/format-output';

export function createListCommand(): CommandModule {
	return {
		command: 'list [path]',
		describe: 'Tree view of exposed queries and mutations',
		builder: (yargs: Argv) =>
			yargs.positional('path', {
				type: 'string',
				describe: 'Optional dot-path to narrow the view',
			}),
		handler: async (argv: any) => {
			const { entries, dispose } = await loadConfig(process.cwd());
			try {
				render(argv.path as string | undefined, entries);
			} finally {
				await dispose();
			}
		},
	};
}

function render(pathArg: string | undefined, entries: ConfigEntry[]): void {
	const segments = pathArg ? pathArg.split('.').filter(Boolean) : [];

	if (segments.length === 0) {
		let first = true;
		for (const entry of entries) {
			if (!first) console.log('');
			first = false;
			console.log(entry.name);
			printTree(discoverActions(bundleOf(entry.handle)));
		}
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

	const bundle = bundleOf(entry.handle);
	const resolved = resolvePath(bundle, rest);

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
	const actions = discoverActions(resolved.node);
	printTree(actions);
}

// ─── Rendering ───────────────────────────────────────────────────────────────

type TreeNode = { name: string; children: Map<string, TreeNode>; action?: Action };

function printTree(items: { path: string[]; action: Action }[]): void {
	if (items.length === 0) {
		console.log('  (no actions exposed)');
		return;
	}
	const root: TreeNode = { name: '', children: new Map() };
	for (const { path, action } of items) {
		let node = root;
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
	printChildren(root, '');
}

function printChildren(node: TreeNode, prefix: string): void {
	const entries = [...node.children.values()];
	entries.forEach((child, idx) => {
		const isLast = idx === entries.length - 1;
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
