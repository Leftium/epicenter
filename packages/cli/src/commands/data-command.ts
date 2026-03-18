/**
 * `epicenter data` — interact with workspace data directly from disk.
 *
 * Reads/writes workspace data via the Y.Doc persistence layer (SQLite).
 * No local server required — operates directly on persisted state.
 *
 * All handlers share the same open/use/destroy lifecycle via `withWorkspace`.
 */

import type { AnyWorkspaceClient } from '@epicenter/workspace';
import type { Argv, CommandModule } from 'yargs';
import { formatYargsOptions, output, outputError } from '../format-output';
import { parseJsonInput, readStdinSync } from '../parse-input';
import {
	type OpenWorkspaceOptions,
	withWorkspace,
} from '../runtime/open-workspace';

// ─── Factory: shared lifecycle for every data command ───────────────────────────

/**
 * Wraps a data operation with the standard CLI lifecycle:
 * open workspace → run operation → output result → destroy.
 *
 * Every handler in this file calls this instead of manually managing
 * openWorkspaceFromDisk/try/catch/destroy.
 */
async function runDataCommand<T>(
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

/** Resolve a table by name, or throw a clear error. */
function resolveTable(client: AnyWorkspaceClient, name: string) {
	const table = client.tables[name];
	if (!table) throw new Error(`Table "${name}" not found`);
	return table;
}

// ─── Input parsing helper ─────────────────────────────────────────────────

/** Parse a value from argv positional, --file, or stdin. Returns undefined on error. */
function resolveInputValue(argv: any): unknown {
	const stdinContent = readStdinSync();
	const valueStr = argv.value as string | undefined;

	if (
		valueStr &&
		!valueStr.startsWith('{') &&
		!valueStr.startsWith('[') &&
		!valueStr.startsWith('"') &&
		!valueStr.startsWith('@')
	) {
		return valueStr;
	}

	const result = parseJsonInput({
		positional: valueStr,
		file: argv.file,
		hasStdin: stdinContent !== undefined,
		stdinContent,
	});

	if (result.error) {
		outputError(result.error.message);
		process.exitCode = 1;
		return undefined;
	}

	return result.data;
}

// ─── KV subcommand (nested) ───────────────────────────────────────────────

function buildKvSubcommand() {
	return {
		command: 'kv <action>',
		describe: 'Manage key-value store',
		builder: (yargs: Argv) =>
			yargs
				.command({
					command: 'get <key>',
					describe: 'Get a value by key',
					builder: (y: Argv) =>
						y
							.positional('key', {
								type: 'string',
								demandOption: true,
							})
							.options(formatYargsOptions()),
					handler: async (argv: any) => {
						await runDataCommand(
							{ dir: argv.dir, workspaceId: argv.workspace },
							(client) => client.kv.get(argv.key),
							argv.format,
						);
					},
				} as unknown as CommandModule)
				.command({
					command: 'set <key> [value]',
					describe: 'Set a value by key',
					builder: (y: Argv) =>
						y
							.positional('key', {
								type: 'string',
								demandOption: true,
							})
							.positional('value', {
								type: 'string',
								description: 'JSON value or @file',
							})
							.option('file', {
								type: 'string',
								description: 'Read value from file',
							})
							.options(formatYargsOptions()),
					handler: async (argv: any) => {
						const parsed = resolveInputValue(argv);
						if (parsed === undefined) return;
						await runDataCommand(
							{ dir: argv.dir, workspaceId: argv.workspace },
							(client) => {
								client.kv.set(argv.key, parsed);
								return {
									status: 'set',
									key: argv.key,
									value: parsed,
								};
							},
							argv.format,
						);
					},
				} as unknown as CommandModule)
				.command({
					command: 'delete <key>',
					aliases: ['reset'],
					describe: 'Delete a value by key (reset to default)',
					builder: (y: Argv) =>
						y
							.positional('key', {
								type: 'string',
								demandOption: true,
							})
							.options(formatYargsOptions()),
					handler: async (argv: any) => {
						await runDataCommand(
							{ dir: argv.dir, workspaceId: argv.workspace },
							(client) => {
								client.kv.delete(argv.key);
								return { status: 'deleted', key: argv.key };
							},
							argv.format,
						);
					},
				} as unknown as CommandModule)
				.demandCommand(1, 'Specify an action: get, set, delete'),
		handler: () => {},
	};
}

// ─── Exported command builder ─────────────────────────────────────────────

export function buildDataCommand() {
	return {
		command: 'data',
		describe: 'Interact with workspace data (tables, KV)',
		builder: (yargs: Argv) =>
			yargs
				.strict(false)
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
				.command({
					command: 'tables',
					describe: 'List all table names',
					builder: (y: Argv) => y.options(formatYargsOptions()),
					handler: async (argv: any) => {
						await runDataCommand(
							{ dir: argv.dir, workspaceId: argv.workspace },
							(client) => Object.keys(client.definitions.tables),
							argv.format,
						);
					},
				} as unknown as CommandModule)
				.command(buildKvSubcommand())
				.command({
					command: 'list <table>',
					describe: 'List all valid rows in a table',
					builder: (y: Argv) =>
						y
							.positional('table', {
								type: 'string',
								demandOption: true,
							})
							.options(formatYargsOptions()),
					handler: async (argv: any) => {
						await runDataCommand(
							{ dir: argv.dir, workspaceId: argv.workspace },
							(client) => resolveTable(client, argv.table).getAllValid(),
							argv.format,
						);
					},
				} as unknown as CommandModule)
				.command({
					command: 'get <table> <id>',
					describe: 'Get a row by ID from a table',
					builder: (y: Argv) =>
						y
							.positional('table', {
								type: 'string',
								demandOption: true,
							})
							.positional('id', {
								type: 'string',
								demandOption: true,
							})
							.options(formatYargsOptions()),
					handler: async (argv: any) => {
						await runDataCommand(
							{ dir: argv.dir, workspaceId: argv.workspace },
							(client) => {
								const result = resolveTable(client, argv.table).get(argv.id);
								if (result.status !== 'valid')
									throw new Error(`Row not found: ${argv.id}`);
								return result.row;
							},
							argv.format,
						);
					},
				} as unknown as CommandModule)
				.command({
					command: 'count <table>',
					describe: 'Count valid rows in a table',
					builder: (y: Argv) =>
						y
							.positional('table', {
								type: 'string',
								demandOption: true,
							})
							.options(formatYargsOptions()),
					handler: async (argv: any) => {
						await runDataCommand(
							{ dir: argv.dir, workspaceId: argv.workspace },
							(client) => ({
								count: resolveTable(client, argv.table).getAllValid().length,
							}),
							argv.format,
						);
					},
				} as unknown as CommandModule)
				.command({
					command: 'delete <table> <id>',
					describe: 'Delete a row by ID from a table',
					builder: (y: Argv) =>
						y
							.positional('table', {
								type: 'string',
								demandOption: true,
							})
							.positional('id', {
								type: 'string',
								demandOption: true,
							})
							.options(formatYargsOptions()),
					handler: async (argv: any) => {
						await runDataCommand(
							{ dir: argv.dir, workspaceId: argv.workspace },
							(client) => {
								resolveTable(client, argv.table).delete(argv.id);
								return { status: 'deleted', id: argv.id };
							},
							argv.format,
						);
					},
				} as unknown as CommandModule)
				.demandCommand(
					1,
					'Specify a subcommand: tables, kv, list, get, count, delete',
				),
		handler: () => {},
	};
}

