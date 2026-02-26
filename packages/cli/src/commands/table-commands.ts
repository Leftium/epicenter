import type { CommandModule } from 'yargs';
import type { ApiClient } from '../api-client.js';
import { formatYargsOptions, output, outputError } from '../format-output.js';
import { parseJsonInput, readStdinSync } from '../parse-input.js';

/**
 * Build a yargs command for table operations via HTTP.
 *
 * Usage: epicenter <workspace> <table> <action>
 */
export function buildTableCommand(
	api: ApiClient,
	workspaceId: string,
	tableName: string,
): CommandModule {
	const ws = api.workspaces({ workspaceId });

	return {
		command: `${tableName} <action>`,
		describe: `Manage ${tableName} table`,
		builder: (yargs) => {
			return yargs
				.command({
					command: 'list',
					describe: 'List all valid rows',
					builder: (y) => y.options(formatYargsOptions()),
					handler: async (argv) => {
						const { data, error } = await ws.tables({ tableName }).get();
						if (error) {
							outputError(String(error));
							process.exitCode = 1;
							return;
						}
						output(data, { format: argv.format as any });
					},
				})
				.command({
					command: 'get <id>',
					describe: 'Get a row by ID',
					builder: (y) =>
						y
							.positional('id', { type: 'string', demandOption: true })
							.options(formatYargsOptions()),
					handler: async (argv) => {
						const id = argv.id as string;
						const { data, error } = await ws
							.tables({ tableName })({ id })
							.get();
						if (error) {
							if (error.status === 404) {
								outputError(`Row not found: ${id}`);
							} else {
								outputError(String(error));
							}
							process.exitCode = 1;
							return;
						}
						output(data, { format: argv.format as any });
					},
				})
				.command({
					command: 'set <id> [json]',
					describe: 'Create or replace a row by ID',
					builder: (y) =>
						y
							.positional('id', { type: 'string', demandOption: true })
							.positional('json', {
								type: 'string',
								description: 'JSON row data or @file',
							})
							.option('file', {
								type: 'string',
								description: 'Read from file',
							})
							.options(formatYargsOptions()),
					handler: async (argv) => {
						const id = argv.id as string;
						const stdinContent = readStdinSync();
						const result = parseJsonInput({
							positional: argv.json,
							file: argv.file,
							hasStdin: stdinContent !== undefined,
							stdinContent,
						});

						if (result.ok === false) {
							outputError(result.error);
							process.exitCode = 1;
							return;
						}

						const { data, error } = await ws
							.tables({ tableName })({ id })
							.put(result.data as any);
						if (error) {
							outputError(String(error));
							process.exitCode = 1;
							return;
						}
						output(data, { format: argv.format as any });
					},
				})
				.command({
					command: 'update <id>',
					describe:
						'Partial update a row using flags (e.g., --title "New Title")',
					builder: (y) =>
						y
							.positional('id', { type: 'string', demandOption: true })
							.options(formatYargsOptions())
							.strict(false),
					handler: async (argv) => {
						const id = argv.id as string;

						const reservedKeys = new Set([
							'_',
							'$0',
							'id',
							'format',
							'help',
							'version',
						]);
						const partial: Record<string, unknown> = {};

						for (const [key, value] of Object.entries(argv)) {
							if (!reservedKeys.has(key) && !key.includes('-')) {
								if (
									typeof value === 'string' &&
									(value.startsWith('{') || value.startsWith('['))
								) {
									try {
										partial[key] = JSON.parse(value);
									} catch {
										partial[key] = value;
									}
								} else {
									partial[key] = value;
								}
							}
						}

						if (Object.keys(partial).length === 0) {
							outputError(
								'No fields to update. Use flags like --title "New Title"',
							);
							process.exitCode = 1;
							return;
						}

						const { data, error } = await ws
							.tables({ tableName })({ id })
							.patch(partial as any);
						if (error) {
							if (error.status === 404) {
								outputError(`Row not found: ${id}`);
							} else {
								outputError(String(error));
							}
							process.exitCode = 1;
							return;
						}
						output(data, { format: argv.format as any });
					},
				})
				.command({
					command: 'delete <id>',
					describe: 'Delete a row by ID',
					builder: (y) =>
						y
							.positional('id', { type: 'string', demandOption: true })
							.options(formatYargsOptions()),
					handler: async (argv) => {
						const id = argv.id as string;
						const { data, error } = await ws
							.tables({ tableName })({ id })
							.delete();
						if (error) {
							outputError(String(error));
							process.exitCode = 1;
							return;
						}
						output(data, { format: argv.format as any });
					},
				})
				.demandCommand(1, 'Specify an action: list, get, set, update, delete');
		},
		handler: () => {},
	};
}
