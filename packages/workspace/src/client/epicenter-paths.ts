/**
 * Node-only path helpers for the playground daemons' persistence files under
 * `~/.epicenter/persistence/<workspaceId>.db`. Override the base directory
 * with `$EPICENTER_HOME`.
 *
 * Scope: this is a playground convention only. Production machine state
 * (machine auth, daemon logs) lives under the platform user-data directory
 * via `env-paths('epicenter')`. Project-local state lives under
 * `<projectDir>/.epicenter/` via `document/workspace-paths.ts`.
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

	persistence(workspaceId: string) {
		return join(resolveHome(), 'persistence', `${workspaceId}.db`);
	},
} as const;
