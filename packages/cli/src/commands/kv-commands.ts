import type { CommandModule } from 'yargs';
import type { ApiClient } from '../api-client.js';
import { formatYargsOptions, output, outputError } from '../format-output.js';
import { parseJsonInput, readStdinSync } from '../parse-input.js';

/**
 * Build a yargs command for KV operations via HTTP.
 *
 * Usage: epicenter <workspace> kv <action> <key>
 */
export function buildKvCommand(
	api: ApiClient,
	workspaceId: string,
): CommandModule {
	const ws = api.workspaces({ workspaceId });

	return {
		command: 'kv <action>',
		describe: 'Manage key-value store',
		builder: (yargs) => {
			return yargs
				.command({
					command: 'get <key>',
					describe: 'Get a value by key',
					builder: (y) =>
						y
							.positional('key', { type: 'string', demandOption: true })
							.options(formatYargsOptions()),
					handler: async (argv) => {
						const key = argv.key as string;
						const { data, error } = await ws.kv({ key }).get();
						if (error) {
							if (error.status === 404) {
								outputError(`Key not found: ${key}`);
							} else {
								outputError(String(error));
							}
							process.exitCode = 1;
							return;
						}
						output(data, { format: argv.format as 'json' | 'jsonl' });
					},
				})
				.command({
					command: 'set <key> [value]',
					describe: 'Set a value by key',
					builder: (y) =>
						y
							.positional('key', { type: 'string', demandOption: true })
							.positional('value', {
								type: 'string',
								description: 'JSON value or @file',
							})
							.option('file', {
								type: 'string',
								description: 'Read value from file',
							})
							.options(formatYargsOptions()),
					handler: async (argv) => {
						const key = argv.key as string;
						const stdinContent = readStdinSync();
						const valueStr = argv.value as string | undefined;

						let value: unknown;
						if (
							valueStr &&
							!valueStr.startsWith('{') &&
							!valueStr.startsWith('[') &&
							!valueStr.startsWith('"') &&
							!valueStr.startsWith('@')
						) {
							value = valueStr;
						} else {
							const result = parseJsonInput({
								positional: valueStr,
								file: argv.file as string | undefined,
								hasStdin: stdinContent !== undefined,
								stdinContent,
							});

							if (!result.ok) {
								outputError(result.error);
								process.exitCode = 1;
								return;
							}
							value = result.data;
						}

						const { error } = await ws.kv({ key }).put(value as any);
						if (error) {
							outputError(String(error));
							process.exitCode = 1;
							return;
						}
						output(
							{ status: 'set', key, value },
							{ format: argv.format as 'json' | 'jsonl' },
						);
					},
				})
				.command({
					command: 'delete <key>',
					aliases: ['reset'],
					describe: 'Delete a value by key (reset to undefined)',
					builder: (y) =>
						y
							.positional('key', { type: 'string', demandOption: true })
							.options(formatYargsOptions()),
					handler: async (argv) => {
						const key = argv.key as string;
						const { error } = await ws.kv({ key }).delete();
						if (error) {
							outputError(String(error));
							process.exitCode = 1;
							return;
						}
						output(
							{ status: 'deleted', key },
							{ format: argv.format as 'json' | 'jsonl' },
						);
					},
				})
				.demandCommand(1, 'Specify an action: get, set, delete');
		},
		handler: () => {},
	};
}
