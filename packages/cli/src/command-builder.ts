import { type Actions, iterateActions } from '@epicenter/workspace';
import { ParseError, Parser } from 'typebox/value';
import type { CommandModule } from 'yargs';
import { jsonSchemaToYargsOptions } from './json-schema-to-yargs';

/**
 * Build yargs command configurations from an actions tree.
 *
 * Iterates over all action definitions and creates CommandModule configs that can be
 * registered with yargs. Separates the concern of building command configs
 * from registering them, enabling cleaner CLI construction.
 *
 * @remarks
 * Actions use closure-based dependency injection - they capture their context
 * (tables, extensions, etc.) at definition time. The handler is called directly
 * with just the validated input.
 *
 * Yargs handles help text display (types, choices, descriptions, required flags).
 * TypeBox's Parser handles the actual validation pipeline: Clone → Default →
 * Convert → Clean → Assert. This means yargs coercion and TypeBox coercion
 * both run, but TypeBox is the single source of truth for validation.
 *
 * @example
 * ```typescript
 * const client = createWorkspace({ ... });
 * const actions = {
 *   posts: {
 *     getAll: defineQuery({ handler: () => client.tables.posts.getAllValid() }),
 *   },
 * };
 * const commands = buildActionCommands(actions);
 * for (const cmd of commands) {
 *   cli = cli.command(cmd);
 * }
 * ```
 */
export function buildActionCommands(actions: Actions): CommandModule[] {
	return [...iterateActions(actions)].map(([action, path]) => {
		const commandPath = path.join(' ');
		const description =
			action.description ??
			`${action.type === 'query' ? 'Query' : 'Mutation'}: ${path.join('.')}`;

		const builder = action.input ? jsonSchemaToYargsOptions(action.input) : {};

		return {
			command: commandPath,
			describe: description,
			builder,
			handler: async (argv: Record<string, unknown>) => {
				if (action.input) {
					try {
						const input = Parser(action.input, argv);
						const output = await action(input);
						console.log(JSON.stringify(output, null, 2));
					} catch (error) {
						if (error instanceof ParseError) {
							console.error('Validation failed:');
							for (const err of error.cause.errors) {
								console.error(
									`  - ${err.instancePath || 'input'}: ${err.message}`,
								);
							}
							process.exit(1);
						}
						throw error;
					}
				} else {
					const output = await action();
					console.log(JSON.stringify(output, null, 2));
				}
			},
		};
	});
}
