// ════════════════════════════════════════════════════════════════════════════
// createWorkspace() builder pattern API
// ════════════════════════════════════════════════════════════════════════════

// Re-export ExtensionExports type (for extension authors)
export type { ExtensionExports } from '../extension';
// Re-export defineExports for extension authors
export { defineExports } from '../extension';
export type {
	WorkspaceClient,
	WorkspaceClientBuilder,
} from './create-workspace';
// The builder pattern API
export { createWorkspace } from './create-workspace';
// Types for the API
export type {
	CreateWorkspaceConfig,
	ExtensionContext,
	ExtensionFactory,
	ExtensionFactoryMap,
	InferExtensionExports,
} from './types';

// Workspace definition helpers
export type { WorkspaceDefinition } from './workspace';
export { defineWorkspace } from './workspace';
