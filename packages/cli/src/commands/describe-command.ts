/**
 * `epicenter describe [workspace-id]` — dump a WorkspaceDescriptor as JSON.
 *
 * Loads the workspace from `epicenter.config.ts`, calls `describeWorkspace()`
 * from `@epicenter/workspace`, and outputs the full descriptor including
 * table schemas, KV definitions, and action metadata.
 *
 * Useful for tooling integration, documentation generation, and debugging.
 */

import { describeWorkspace } from '@epicenter/workspace';
import type { Argv, CommandModule } from 'yargs';
import { withWorkspace } from '../runtime/open-workspace';
import { output, outputError } from '../util/format-output';
import { withWorkspaceOptions } from '../util/with-workspace-options';

/**
 * Build the `describe` command.
 *
 * Outputs a JSON-serializable WorkspaceDescriptor that includes:
 * - `id`: Workspace ID
 * - `tables`: Table schemas (JSON Schema format)
 * - `kv`: KV definitions
 * - `awareness`: Awareness definitions
 * - `actions`: Action metadata (path, type, description, input schema)
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
			try {
				const result = await withWorkspace(
					{ dir: argv.dir, workspaceId: argv.workspace },
					(client) => describeWorkspace(client),
				);
				output(result, { format: argv.format });
			} catch (err) {
				outputError(err instanceof Error ? err.message : String(err));
				process.exitCode = 1;
			}
		},
	};
}
