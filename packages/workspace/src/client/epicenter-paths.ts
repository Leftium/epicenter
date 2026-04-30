/**
 * Node-only path helpers for files under the Epicenter home directory.
 *
 * Override the home directory with `$EPICENTER_HOME`. These paths are
 * machine-local, not project-local. Project data under `<projectDir>/.epicenter`
 * is handled by `document/workspace-paths.ts`.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

function resolveHome(): string {
	return Bun.env.EPICENTER_HOME ?? join(homedir(), '.epicenter');
}

export const epicenterPaths = {
	home() {
		return resolveHome();
	},

	authSessions() {
		return join(resolveHome(), 'auth', 'sessions.json');
	},

	persistence(workspaceId: string) {
		return join(resolveHome(), 'persistence', `${workspaceId}.db`);
	},
} as const;
