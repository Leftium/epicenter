/**
 * `epicenter data` — interact with workspace data directly from disk.
 *
 * Reads/writes workspace data via the Y.Doc persistence layer (SQLite).
 * No local server required — operates directly on persisted state.
 */

import type { Argv, CommandModule } from 'yargs';
import {
	formatYargsOptions,
	output,
	outputError,
} from '../format-output';
import { parseJsonInput, readStdinSync } from '../parse-input'; // eslint-disable-line @typescript-eslint/no-unused-vars
import { openWorkspaceFromDisk } from '../runtime/open-workspace';


/**
 * Build the `data` command group for interacting with workspace data.
 *
 * Uses direct disk access via filesystem persistence. The `--dir` flag
 * points to a project directory containing `epicenter.config.ts`.
 */
export function buildDataCommand(_serverUrl: string) {
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
				.command(buildTablesSubcommand())
				.command(buildKvSubcommand())
				.command(buildTableListCommand())
				.command(buildTableGetCommand())
				.command(buildTableCountCommand())
				.command(buildTableDeleteCommand())
				.demandCommand(1, 'Specify a subcommand: tables, kv, list, get, count, delete'),
		handler: () => {},
	};
}

// ---------------------------------------------------------------------------
// tables — list table names
// ---------------------------------------------------------------------------

function buildTablesSubcommand() {
	return {
		command: 'tables',
		describe: 'List all table names',
		builder: (yargs: Argv) => yargs.options(formatYargsOptions()),
		handler: async (argv: any) => {
			try {
				const { client, destroy } = await openWorkspaceFromDisk({
					dir: argv.dir,
					workspaceId: argv.workspace,
				});
				const tableNames = Object.keys(client.definitions.tables);
				output(tableNames, { format: argv.format });
				await destroy();
			} catch (err) {
				outputError(err instanceof Error ? err.message : String(err));
				process.exitCode = 1;
			}
		},
	};
}

// ---------------------------------------------------------------------------
// kv — key-value store operations
// ---------------------------------------------------------------------------

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
							.positional('key', { type: 'string', demandOption: true })
							.options(formatYargsOptions()),
					handler: async (argv: any) => {
						try {
							const { client, destroy } = await openWorkspaceFromDisk({
								dir: argv.dir,
								workspaceId: argv.workspace,
							});
							const value = client.kv.get(argv.key);
							output(value, { format: argv.format });
							await destroy();
						} catch (err) {
							outputError(err instanceof Error ? err.message : String(err));
							process.exitCode = 1;
						}
					},
			} as unknown as CommandModule)
			.command({
					command: 'set <key> [value]',
					describe: 'Set a value by key',
					builder: (y: Argv) =>
						y
							.positional('key', { type: 'string', demandOption: true })
							.positional('value', { type: 'string', description: 'JSON value or @file' })
							.option('file', { type: 'string', description: 'Read value from file' })
							.options(formatYargsOptions()),
					handler: async (argv: any) => {
						try {
							const stdinContent = readStdinSync();
							const valueStr = argv.value;

							let parsed: unknown;
							if (valueStr && !valueStr.startsWith('{') && !valueStr.startsWith('[') && !valueStr.startsWith('"') && !valueStr.startsWith('@')) {
								parsed = valueStr;
							} else {
								const result = parseJsonInput({ positional: valueStr, file: argv.file, hasStdin: stdinContent !== undefined, stdinContent });
								if (result.error) { outputError(result.error.message); process.exitCode = 1; return; }
								parsed = result.data;
							}

							const { client, destroy } = await openWorkspaceFromDisk({ dir: argv.dir, workspaceId: argv.workspace });
							client.kv.set(argv.key, parsed);
							output({ status: 'set', key: argv.key, value: parsed }, { format: argv.format });
							await destroy();
						} catch (err) {
							outputError(err instanceof Error ? err.message : String(err));
							process.exitCode = 1;
						}
					},
			} as unknown as CommandModule)
			.command({
					command: 'delete <key>',
					aliases: ['reset'],
					describe: 'Delete a value by key (reset to default)',
					builder: (y: Argv) =>
						y.positional('key', { type: 'string', demandOption: true }).options(formatYargsOptions()),
					handler: async (argv: any) => {
						try {
							const { client, destroy } = await openWorkspaceFromDisk({ dir: argv.dir, workspaceId: argv.workspace });
							client.kv.delete(argv.key);
							output({ status: 'deleted', key: argv.key }, { format: argv.format });
							await destroy();
						} catch (err) {
							outputError(err instanceof Error ? err.message : String(err));
							process.exitCode = 1;
						}
					},
			} as unknown as CommandModule)
				.demandCommand(1, 'Specify an action: get, set, delete'),
		handler: () => {},
	};
}

// ---------------------------------------------------------------------------
// <table> — table row operations (list, get, set, delete)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Table row operations — each is a top-level data subcommand
// Usage: epicenter data list <table>
//        epicenter data get <table> <id>
//        epicenter data count <table>
//        epicenter data delete <table> <id>
// ---------------------------------------------------------------------------

function buildTableListCommand() {
	return {
		command: 'list <table>',
		describe: 'List all valid rows in a table',
		builder: (y: Argv) =>
			y.positional('table', { type: 'string', demandOption: true, description: 'Table name' }).options(formatYargsOptions()),
		handler: async (argv: any) => {
			try {
				const { client, destroy } = await openWorkspaceFromDisk({ dir: argv.dir, workspaceId: argv.workspace });
				const table = client.tables[argv.table];
				if (!table) { outputError(`Table "${argv.table}" not found`); process.exitCode = 1; await destroy(); return; }
				output(table.getAllValid(), { format: argv.format });
				await destroy();
			} catch (err) {
				outputError(err instanceof Error ? err.message : String(err));
				process.exitCode = 1;
			}
		},
	} as unknown as CommandModule;
}

function buildTableGetCommand() {
	return {
		command: 'get <table> <id>',
		describe: 'Get a row by ID from a table',
		builder: (y: Argv) =>
			y
				.positional('table', { type: 'string', demandOption: true, description: 'Table name' })
				.positional('id', { type: 'string', demandOption: true, description: 'Row ID' })
				.options(formatYargsOptions()),
		handler: async (argv: any) => {
			try {
				const { client, destroy } = await openWorkspaceFromDisk({ dir: argv.dir, workspaceId: argv.workspace });
				const table = client.tables[argv.table];
				if (!table) { outputError(`Table "${argv.table}" not found`); process.exitCode = 1; await destroy(); return; }
				const result = table.get(argv.id);
				if (result.status === 'valid') {
					output(result.row, { format: argv.format });
				} else {
					outputError(`Row not found: ${argv.id}`);
					process.exitCode = 1;
				}
				await destroy();
			} catch (err) {
				outputError(err instanceof Error ? err.message : String(err));
				process.exitCode = 1;
			}
		},
	} as unknown as CommandModule;
}

function buildTableCountCommand() {
	return {
		command: 'count <table>',
		describe: 'Count valid rows in a table',
		builder: (y: Argv) =>
			y.positional('table', { type: 'string', demandOption: true, description: 'Table name' }).options(formatYargsOptions()),
		handler: async (argv: any) => {
			try {
				const { client, destroy } = await openWorkspaceFromDisk({ dir: argv.dir, workspaceId: argv.workspace });
				const table = client.tables[argv.table];
				if (!table) { outputError(`Table "${argv.table}" not found`); process.exitCode = 1; await destroy(); return; }
				output({ count: table.getAllValid().length }, { format: argv.format });
				await destroy();
			} catch (err) {
				outputError(err instanceof Error ? err.message : String(err));
				process.exitCode = 1;
			}
		},
	} as unknown as CommandModule;
}

function buildTableDeleteCommand() {
	return {
		command: 'delete <table> <id>',
		describe: 'Delete a row by ID from a table',
		builder: (y: Argv) =>
			y
				.positional('table', { type: 'string', demandOption: true, description: 'Table name' })
				.positional('id', { type: 'string', demandOption: true, description: 'Row ID' })
				.options(formatYargsOptions()),
		handler: async (argv: any) => {
			try {
				const { client, destroy } = await openWorkspaceFromDisk({ dir: argv.dir, workspaceId: argv.workspace });
				const table = client.tables[argv.table];
				if (!table) { outputError(`Table "${argv.table}" not found`); process.exitCode = 1; await destroy(); return; }
				table.delete(argv.id);
				output({ status: 'deleted', id: argv.id }, { format: argv.format });
				await destroy();
			} catch (err) {
				outputError(err instanceof Error ? err.message : String(err));
				process.exitCode = 1;
			}
		},
	} as unknown as CommandModule;
}
