/** @module @epicenter/cli — Public API for the Epicenter CLI package. */

export { createCLI } from './cli';
export {
	type AnyWorkspaceClient,
	type DiscoveredWorkspace,
	discoverWorkspaces,
	resolveWorkspace,
	type WorkspaceResolution,
} from './config/resolve-config';
export { createAuthApi, type AuthApi } from './auth/api';
export { cacheDir, resolveEpicenterHome, workspacesDir } from './util/paths';
export { loadConfig, type LoadConfigResult } from './config/load-config';
