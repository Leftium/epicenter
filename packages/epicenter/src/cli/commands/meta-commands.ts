import type { CommandModule } from 'yargs';
import type { CommandConfig } from '../discovery.js';
import { output, formatYargsOptions } from '../format-output.js';

/**
 * Build meta commands (tables, workspaces).
 */
export function buildMetaCommands(config: CommandConfig): CommandModule[] {
	const commands: CommandModule[] = [];

	// 'tables' command - list all table names
	commands.push({
		command: 'tables',
		describe: 'List all table names',
		builder: (yargs) => yargs.options(formatYargsOptions()),
		handler: (argv) => {
			if (config.mode === 'single') {
				// Single workspace: just list table names
				const tableNames = Object.keys(config.clients[0]!.tables);
				output(tableNames, { format: argv.format as any });
			} else {
				// Multi workspace: list tables per workspace
				const result: Record<string, string[]> = {};
				for (const client of config.clients) {
					result[client.id] = Object.keys(client.tables);
				}
				output(result, { format: argv.format as any });
			}
		},
	});

	// 'workspaces' command - list all workspaces
	commands.push({
		command: 'workspaces',
		describe: 'List all workspaces',
		builder: (yargs) => yargs.options(formatYargsOptions()),
		handler: (argv) => {
			const ids = config.clients.map((c) => c.id);
			output(ids, { format: argv.format as any });
		},
	});

	return commands;
}

/** Reserved command names that cannot be used as workspace or table names */
export const RESERVED_COMMANDS = [
	'serve',
	'tables',
	'workspaces',
	'kv',
	'help',
	'version',
	'init',
] as const;

export type ReservedCommand = (typeof RESERVED_COMMANDS)[number];

/**
 * Check if a name is a reserved command.
 */
export function isReservedCommand(name: string): name is ReservedCommand {
	return RESERVED_COMMANDS.includes(name as ReservedCommand);
}
