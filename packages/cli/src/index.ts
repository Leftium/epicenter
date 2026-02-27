export { createCLI } from './cli';
export {
	type AnyWorkspaceClient,
	type DiscoveredWorkspace,
	discoverWorkspaces,
	resolveWorkspace,
	type WorkspaceResolution,
} from './discovery';
export { cacheDir, resolveEpicenterHome, workspacesDir } from './paths';
