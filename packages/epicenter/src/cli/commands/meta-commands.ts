import type { CommandModule } from 'yargs';
import type { AnyWorkspaceClient } from '../discovery.js';
import { output, formatYargsOptions } from '../format-output.js';

/**
 * Build meta commands (tables).
 */
export function buildMetaCommands(client: AnyWorkspaceClient): CommandModule[] {
	return [
		{
			command: 'tables',
			describe: 'List all table names',
			builder: (yargs) => yargs.options(formatYargsOptions()),
			handler: (argv) => {
				const tableNames = Object.keys(client.tables);
				output(tableNames, { format: argv.format as any });
			},
		},
	];
}

/** Reserved command names that cannot be used as workspace or table names */
export const RESERVED_COMMANDS = [
	'serve',
	'tables',
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
