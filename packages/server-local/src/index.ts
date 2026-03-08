export type { AuthUser } from './middleware/auth';
export { DEFAULT_PORT, serve } from './server';
export {
	createSidecar,
	type SidecarApp,
	type SidecarAuthConfig,
	type SidecarConfig,
} from './sidecar';
export { createWorkspacePlugin } from './workspace';
