/**
 * `epicenter describe` — dump a WorkspaceDescriptor as JSON.
 *
 * Outputs table schemas, KV definitions, and action metadata.
 * Useful for tooling integration, documentation generation, and debugging.
 */

import { describeWorkspace } from '@epicenter/workspace';
import type { Argv, CommandModule } from 'yargs';
import { runCommand, withWorkspaceOptions } from '../util/workspace';

/**
 * Build the `describe` command.
 *
 * @example
 * ```bash
 * epicenter describe
 * epicenter describe -w my-workspace
 * epicenter describe --format json | jq '.tables'
 * ```
 */
export function buildDescribeCommand(): CommandModule {
	return {
		command: 'describe',
		describe: 'Describe workspace schema, actions, and KV definitions',
		builder: (y: Argv) => withWorkspaceOptions(y),
		handler: async (argv: any) => {
			await runCommand(
				{ dir: argv.dir, workspaceId: argv.workspace },
				(client) => describeWorkspace(client),
				argv.format,
			);
		},
	};
}
