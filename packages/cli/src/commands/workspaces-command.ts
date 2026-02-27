import type { CommandModule } from 'yargs';
import type { ApiClient } from '../api-client.js';
import { outputError } from '../format-output.js';

export function buildWorkspacesCommand(api: ApiClient): CommandModule {
	return {
		command: 'workspaces',
		describe: 'List all loaded workspaces',
		handler: async () => {
			const { data, error } = await api.get();
			if (error) {
				outputError(`Server responded with ${error.status}`);
				process.exitCode = 1;
				return;
			}
			if (!data.workspaces) {
				outputError('Server is not a local server (no workspaces found).');
				process.exitCode = 1;
				return;
			}
			for (const id of data.workspaces) {
				console.log(id);
			}
		},
	};
}
