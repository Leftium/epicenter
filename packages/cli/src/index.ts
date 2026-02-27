/** @module @epicenter/cli — Public API for the Epicenter CLI package. */

export { createCLI } from './cli';
export { createHttpClient, type HttpClient } from './http-client';
export {
	type AnyWorkspaceClient,
	type DiscoveredWorkspace,
	discoverWorkspaces,
	resolveWorkspace,
	type WorkspaceResolution,
} from './discovery';
export { cacheDir, resolveEpicenterHome, workspacesDir } from './paths';
