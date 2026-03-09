import type { Argv, CommandModule } from 'yargs';

const UNAVAILABLE_MESSAGE =
	'Self-hosted hub is not yet available. Use Epicenter Cloud at https://epicenter.so or see docs for Cloudflare Workers deployment.';

/**
 * Build the top-level `hub` command group for managing the Epicenter hub.
 * @param home - Path to the Epicenter home directory.
 * @returns A yargs CommandModule with start, status, and stop subcommands.
 */
export function buildHubCommand(_home: string): CommandModule {
	return {
		command: 'hub <subcommand>',
		describe: 'Manage the Epicenter hub',
		builder: (y: Argv) =>
			y
				.command({
					command: 'start',
					describe: 'Start the Epicenter hub',
					handler: () => console.log(UNAVAILABLE_MESSAGE),
				})
				.command({
					command: 'status',
					describe: 'Show the status of the Epicenter hub',
					handler: () => console.log(UNAVAILABLE_MESSAGE),
				})
				.command({
					command: 'stop',
					describe: 'Stop the Epicenter hub',
					handler: () => console.log(UNAVAILABLE_MESSAGE),
				})
				.demandCommand(1, 'Specify a subcommand: start, status, stop')
				.strict(),
		handler: () => {},
	};
}
