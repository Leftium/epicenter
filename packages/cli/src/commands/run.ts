/**
 * `epicenter run <dot.path> [args...]` — invoke a `defineQuery` / `defineMutation`
 * by dot-path through an opened document handle.
 *
 * Resolution: `path[0]` is the export name from `epicenter.config.ts`; the
 * remaining segments walk into the underlying bundle (the handle's prototype).
 */

import type { Argv, CommandModule } from 'yargs';
import { loadConfig, type ConfigEntry } from '../load-config';
import {
	formatYargsOptions,
	output,
	outputError,
} from '../util/format-output';
import { parseJsonInput, readStdinSync } from '../util/parse-input';
import {
	bundleOf,
	discoverActions,
	resolvePath,
} from '../util/discover-actions';
import { typeboxToYargsOptions } from '../util/typebox-to-yargs';

export function createRunCommand(): CommandModule {
	return {
		command: 'run <action> [input]',
		describe: 'Invoke a defineQuery / defineMutation by dot-path',
		builder: (yargs: Argv) =>
			yargs
				.positional('action', {
					type: 'string',
					demandOption: true,
					describe: 'Action path, e.g. tabManager.savedTabs.create',
				})
				.positional('input', {
					type: 'string',
					describe: 'Inline JSON or @file.json',
				})
				.option('file', {
					type: 'string',
					description: 'Path to a JSON file containing the action input',
				})
				.options(formatYargsOptions())
				.strict(false),
		handler: async (argv: any) => {
			const { entries, dispose } = await loadConfig(process.cwd());
			try {
				await invoke(argv, entries);
			} finally {
				await dispose();
			}
		},
	};
}

async function invoke(
	argv: Record<string, unknown>,
	entries: ConfigEntry[],
): Promise<void> {
	const actionPath = String(argv.action ?? '');
	const segments = actionPath.split('.').filter(Boolean);

	if (segments.length === 0) {
		throw new Error('Provide an action path, e.g. `tabManager.savedTabs.list`.');
	}

	const exportName = segments[0]!;
	const rest = segments.slice(1);
	const entry = entries.find((e) => e.name === exportName);
	if (!entry) {
		const names = entries.map((e) => e.name).join(', ');
		throw new Error(
			`No export named "${exportName}" in epicenter.config.ts. ` +
				`Available exports: ${names}`,
		);
	}

	// Wait for persistence / sync readiness before reading.
	const bundle = bundleOf(entry.handle);
	if (bundle.whenReady) await bundle.whenReady;

	const resolved = resolvePath(bundle, rest);

	if (resolved.kind === 'missing') {
		outputError(
			`"${actionPath}" is not defined. ` +
				`Stopped at "${[exportName, ...resolved.lastGoodPath].join('.')}" ` +
				`while looking for "${resolved.missingSegment}".`,
		);
		suggestSiblings(exportName, bundle, resolved.lastGoodPath);
		throw new Error('Action not found');
	}

	if (resolved.kind === 'subtree') {
		outputError(`"${actionPath}" is not a runnable action.`);
		suggestSiblings(exportName, bundle, resolved.path);
		throw new Error('Not an action');
	}

	const { action } = resolved;
	const input = await resolveInput(argv, action);
	const result =
		action.input !== undefined ? await action(input) : await action();
	output(result, { format: argv.format as 'json' | 'jsonl' | undefined });
}

async function resolveInput(
	argv: Record<string, unknown>,
	action: { input?: unknown },
): Promise<unknown> {
	if (action.input === undefined) return undefined;

	// Complex input escape hatch: positional `@file.json`, inline JSON,
	// `--file`, or piped stdin.
	const positional =
		typeof argv.input === 'string' && argv.input.length > 0
			? (argv.input as string)
			: undefined;
	const file = typeof argv.file === 'string' ? (argv.file as string) : undefined;
	const stdinContent = readStdinSync();
	const hasStdin = stdinContent !== undefined;

	if (positional || file || hasStdin) {
		const { data, error } = parseJsonInput({
			positional,
			file,
			hasStdin,
			stdinContent,
		});
		if (error) throw new Error(error.message);
		return data;
	}

	// Flat schemas: map TypeBox fields to yargs flags already parsed by yargs.
	const yargsOpts = typeboxToYargsOptions(action.input as never);
	const input: Record<string, unknown> = {};
	for (const key of Object.keys(yargsOpts)) {
		if (argv[key] !== undefined) input[key] = argv[key];
	}
	return input;
}

function suggestSiblings(
	exportName: string,
	bundle: unknown,
	parentPath: string[],
): void {
	let node: unknown = bundle;
	for (const seg of parentPath) {
		if (node == null || typeof node !== 'object') return;
		node = (node as Record<string, unknown>)[seg];
	}
	const siblings = discoverActions(node);
	if (siblings.length === 0) return;

	outputError('');
	outputError('Exposed actions at this path:');
	for (const { path, action } of siblings) {
		const full = [exportName, ...parentPath, ...path].join('.');
		outputError(`  ${full}  (${action.type})`);
	}
}
