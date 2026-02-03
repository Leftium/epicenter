import type { CommandModule } from 'yargs';
import type { AttachedActions } from '../shared/actions';
import { iterateAttachedActions } from '../shared/actions';
import { standardSchemaToJsonSchema } from '../shared/standard-schema/to-json-schema';
import { jsonSchemaToYargsOptions } from './json-schema-to-yargs';

/**
 * Build yargs command configurations from an attached actions tree.
 *
 * Iterates over all attached actions and creates CommandModule configs that can be
 * registered with yargs. Separates the concern of building command configs
 * from registering them, enabling cleaner CLI construction.
 *
 * @remarks
 * Only works with attached actions (from client.actions). Attached actions are
 * callable functions that have the workspace context pre-filled.
 *
 * @example
 * ```typescript
 * const client = createWorkspace({ ... }).withActions({ posts: { ... } });
 * const commands = buildActionCommands(client.actions);
 * for (const cmd of commands) {
 *   cli = cli.command(cmd);
 * }
 * ```
 */
export function buildActionCommands(actions: AttachedActions): CommandModule[] {
	return [...iterateAttachedActions(actions)].map(([action, path]) => {
		const commandPath = path.join(' ');
		const description =
			action.description ??
			`${action.type === 'query' ? 'Query' : 'Mutation'}: ${path.join('.')}`;

		const jsonSchema = action.input
			? (standardSchemaToJsonSchema(action.input) as Record<string, unknown>)
			: undefined;

		const builder = jsonSchema ? jsonSchemaToYargsOptions(jsonSchema) : {};

		return {
			command: commandPath,
			describe: description,
			builder,
			handler: async (argv: Record<string, unknown>) => {
				const input = extractInputFromArgv(argv, jsonSchema);
				let validatedInput: unknown;

				if (action.input) {
					const result = await action.input['~standard'].validate(input);
					if (result.issues) {
						console.error('Validation failed:');
						for (const issue of result.issues) {
							console.error(
								`  - ${issue.path?.join('.') ?? 'input'}: ${issue.message}`,
							);
						}
						process.exit(1);
					}
					validatedInput = result.value;
				}

				const output = await (action as (input?: unknown) => unknown)(
					validatedInput,
				);
				console.log(JSON.stringify(output, null, 2));
			},
		};
	});
}

function extractInputFromArgv(
	argv: Record<string, unknown>,
	jsonSchema: Record<string, unknown> | undefined,
): Record<string, unknown> {
	if (!jsonSchema || jsonSchema.type !== 'object' || !jsonSchema.properties) {
		return {};
	}

	const properties = jsonSchema.properties as Record<string, unknown>;
	const input: Record<string, unknown> = {};

	for (const key of Object.keys(properties)) {
		if (key in argv && argv[key] !== undefined) {
			input[key] = argv[key];
		}
	}

	return input;
}
