/**
 * Config-routed daemon extension discovery and startup. Node/Bun-only.
 *
 * `epicenter.config.ts` imports daemon extension modules and lists them in
 * `routes`.
 */

export {
	discoverWorkspaceApps,
	WORKSPACES_DIRNAME,
	type WorkspaceAppEntry,
} from './discover.js';
export { WorkspaceAppError } from './errors.js';
export {
	type StartDaemonWorkspaceAppsOptions,
	type StartDaemonWorkspaceAppsResult,
	startDaemonWorkspaceApps,
} from './start-daemon-workspace-apps.js';
