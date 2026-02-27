export { createCLI } from './cli';
export {
	type AnyWorkspaceClient,
	type DiscoveredWorkspace,
	discoverWorkspaces,
	resolveWorkspace,
	type WorkspaceResolution,
} from './discovery';
export { resolveEpicenterHome, workspacesDir, cacheDir } from './paths';
