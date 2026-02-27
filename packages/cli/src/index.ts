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
