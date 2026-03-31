/**
 * Shared helpers for workspace-scoped CLI commands.
 *
 * Provides common yargs options (`--dir`, `--workspace`, `--format`) and the
 * `runDataCommand` lifecycle wrapper used by every table/KV command.
 */

import type { AnyWorkspaceClient } from '@epicenter/workspace';
import type { Argv } from 'yargs';
import { formatYargsOptions, output, outputError } from './format-output';
import {
	type OpenWorkspaceOptions,
	withWorkspace,
} from '../runtime/open-workspace';

/**
 * Add the standard workspace-scoped options to a yargs builder.
 *
 * Every command that operates on a workspace needs `--dir` (project directory),
 * `--workspace` (workspace ID when config exports multiple), and `--format`
 * (output formatting). Call this in your `builder` to avoid duplicating the
 * option definitions across every command file.
 *
 * @example
 * ```typescript
 * builder: (y: Argv) =>
 *   withWorkspaceOptions(y)
 *     .positional('table', { type: 'string', demandOption: true }),
 * ```
 */
export function withWorkspaceOptions<T>(y: Argv<T>) {
	return y
		.option('dir', {
			type: 'string',
			default: '.',
			alias: 'C',
			description: 'Directory containing epicenter.config.ts',
		})
		.option('workspace', {
			type: 'string',
			alias: 'w',
			description: 'Workspace ID (required if config has multiple workspaces)',
		})
		.options(formatYargsOptions());
}

/**
 * Run a data operation with the standard CLI lifecycle:
 * open workspace → run operation → output result → dispose.
 *
 * Every table/KV command calls this instead of manually managing
 * the open/use/dispose lifecycle.
 *
 * @example
 * ```typescript
 * await runDataCommand(
 *   { dir: argv.dir, workspaceId: argv.workspace },
 *   (client) => client.tables.notes.getAllValid(),
 *   argv.format,
 * );
 * ```
 */
export async function runDataCommand<T>(
	opts: OpenWorkspaceOptions,
	fn: (client: AnyWorkspaceClient) => T | Promise<T>,
	format?: 'json' | 'jsonl',
): Promise<void> {
	try {
		const result = await withWorkspace(opts, fn);
		output(result, { format });
	} catch (err) {
		outputError(err instanceof Error ? err.message : String(err));
		process.exitCode = 1;
	}
}

/**
 * Resolve a table by name from a workspace client, or throw a clear error.
 *
 * @example
 * ```typescript
 * const table = resolveTable(client, 'posts');
 * const rows = table.getAllValid();
 * ```
 */
export function resolveTable(client: AnyWorkspaceClient, name: string) {
	const table = client.tables[name];
	if (!table) throw new Error(`Table "${name}" not found`);
	return table;
}
