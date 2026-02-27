import type { CommandModule } from 'yargs';
import { output, outputError } from './format-output';
import { parseJsonInput, readStdinSync } from './parse-input';

/**
 * Build a yargs command for running actions via HTTP.
 *
 * Usage: epicenter <workspace> action <path> [json]
 *
 * The action path uses dot notation (e.g., "posts.create").
 * Queries use GET, mutations use POST. The command determines
 * the method based on whether JSON input is provided — if input
 * is given, it's a POST (mutation); otherwise GET (query).
 */
export function buildActionCommand(
	baseUrl: string,
	workspaceId: string,
): CommandModule {
	return {
		command: 'action <path> [json]',
		describe: 'Run an action (query or mutation)',
		builder: (yargs) =>
			yargs
				.positional('path', {
					type: 'string',
					demandOption: true,
					description: 'Action path (e.g., posts.getAll)',
				})
				.positional('json', {
					type: 'string',
					description: 'JSON input or @file (triggers mutation)',
				})
				.option('file', {
					type: 'string',
					description: 'Read input from file',
				})
				.option('mutation', {
					type: 'boolean',
					description: 'Force mutation (POST) even without input',
					default: false,
				}),
		handler: async (argv) => {
			const actionPath = (argv.path as string).replace(/\./g, '/');
			const stdinContent = readStdinSync();
			const hasInput =
				argv.json !== undefined ||
				argv.file !== undefined ||
				stdinContent !== undefined;

			// baseUrl is provided by the caller
			const url = `${baseUrl}/workspaces/${workspaceId}/actions/${actionPath}`;

			if (hasInput || argv.mutation) {
				// Mutation: POST with body
				let body: unknown = undefined;
				if (hasInput) {
					const result = parseJsonInput({
						positional: argv.json as string | undefined,
						file: argv.file as string | undefined,
						hasStdin: stdinContent !== undefined,
						stdinContent,
					});
					if (!result.ok) {
						outputError(result.error);
						process.exitCode = 1;
						return;
					}
					body = result.data;
				}

				const response = await fetch(url, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: body !== undefined ? JSON.stringify(body) : undefined,
				});

				if (!response.ok) {
					const text = await response.text();
					outputError(`Action failed (${response.status}): ${text}`);
					process.exitCode = 1;
					return;
				}

				const data = await response.json();
				output(data);
			} else {
				// Query: GET
				const response = await fetch(url);

				if (!response.ok) {
					const text = await response.text();
					outputError(`Action failed (${response.status}): ${text}`);
					process.exitCode = 1;
					return;
				}

				const data = await response.json();
				output(data);
			}
		},
	};
}
