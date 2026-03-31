/**
 * `epicenter run <action> [--args]` — invoke a workspace action.
 *
 * Loads the workspace from `epicenter.config.ts`, finds the action by dot-path
 * using `iterateActions()`, converts the action's input schema to CLI flags
 * via `typeboxToYargsOptions()`, calls the action, and outputs the result.
 *
 * Actions are callable functions defined via `defineQuery`/`defineMutation`
 * in the workspace. The dot-path corresponds to the nested object structure
 * (e.g., `posts.create` for `actions.posts.create`).
 */

import type { Action } from '@epicenter/workspace';
import { iterateActions } from '@epicenter/workspace';
import type { Argv, CommandModule } from 'yargs';
import { withWorkspace } from '../runtime/open-workspace';
import { output, outputError } from '../util/format-output';
import { typeboxToYargsOptions } from '../util/typebox-to-yargs';
import { withWorkspaceOptions } from '../util/with-workspace-options';

/**
 * Build the `run` command.
 *
 * Invokes a workspace action by its dot-path. If the action has an input
 * schema (TypeBox `Type.Object(...)`), the schema fields are exposed as
 * CLI flags automatically.
 *
 * @example
 * ```bash
 * # Action with no input
 * epicenter run posts.getAll
 *
 * # Action with input schema converted to CLI flags
 * epicenter run posts.create --title "Hello World"
 *
 * # With workspace selection
 * epicenter run posts.create --title "Hi" -w my-blog
 * ```
 */
export function buildRunCommand(): CommandModule {
	return {
		command: 'run <action>',
		describe: 'Invoke a workspace action by dot-path',
		builder: (y: Argv) =>
			withWorkspaceOptions(y)
				.positional('action', {
					type: 'string',
					demandOption: true,
					describe:
						'Action path in dot notation (e.g. posts.create)',
				})
				.strict(false),
		handler: async (argv: any) => {
			const actionPath = (argv.action as string).split('.');

			try {
				const result = await withWorkspace(
					{ dir: argv.dir, workspaceId: argv.workspace },
					async (client) => {
						if (!client.actions) {
							throw new Error('This workspace has no actions defined');
						}

						// Find action by dot-path
						let found: Action | undefined;
						for (const [action, path] of iterateActions(client.actions)) {
							if (path.join('.') === actionPath.join('.')) {
								found = action;
								break;
							}
						}

						if (!found) {
							// List available actions for a helpful error
							const available: string[] = [];
							for (const [, path] of iterateActions(client.actions)) {
								available.push(path.join('.'));
							}
							const msg = available.length > 0
								? `Action "${argv.action}" not found. Available actions:\n  ${available.join('\n  ')}`
								: `Action "${argv.action}" not found. No actions defined in this workspace.`;
							throw new Error(msg);
						}

						// Build input from CLI args if action has input schema
						let input: Record<string, unknown> | undefined;
						if (found.input) {
							const yargsOpts = typeboxToYargsOptions(found.input);
							// Extract only the keys defined by the action's input schema
							input = {};
							for (const key of Object.keys(yargsOpts)) {
								if (argv[key] !== undefined) {
									input[key] = argv[key];
								}
							}
						}

						// Call the action (it IS the callable function)
						if (input) {
							return await found(input);
						}
						return await (found as Action<undefined>)();
					},
				);
				output(result, { format: argv.format });
			} catch (err) {
				outputError(err instanceof Error ? err.message : String(err));
				process.exitCode = 1;
			}
		},
	};
}
