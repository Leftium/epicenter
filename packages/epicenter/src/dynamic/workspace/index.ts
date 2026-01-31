// Re-export WorkspaceDoc from workspace-doc (the canonical location)
export type { WorkspaceDoc } from '../docs/workspace-doc';
export type {
	ExtensionContext,
	ExtensionExports,
	ExtensionFactory,
	ExtensionFactoryMap,
	InferExtensionExports,
} from '../extension';
export { defineExports } from '../extension';
// Normalization helpers (for external use if needed)
export {
	DEFAULT_KV_ICON,
	isKvDefinition,
	isTableDefinition,
	normalizeIcon,
} from './normalize';
export type { WorkspaceDefinition } from './workspace';
export { defineWorkspace } from './workspace';
