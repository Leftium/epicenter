import { createWorkspace } from '@epicenter/workspace';
import { WORKSPACE_TEMPLATE_BY_ID } from '$lib/templates';
import { workspacePersistence } from './workspace-persistence';

/**
 * Create a workspace client with persistence.
 *
 * Looks up the workspace definition from the template registry
 * by workspace ID, then creates a workspace client with persistence.
 *
 * @param workspaceId - The workspace ID (must match a registered template)
 * @returns A workspace client with persistence pre-configured
 */
export function createWorkspaceClient(workspaceId: string) {
	const template =
		WORKSPACE_TEMPLATE_BY_ID[
			workspaceId as keyof typeof WORKSPACE_TEMPLATE_BY_ID
		];
	if (!template) {
		throw new Error(
			`Unknown workspace template: "${workspaceId}". Available: ${Object.keys(WORKSPACE_TEMPLATE_BY_ID).join(', ')}`,
		);
	}
	return createWorkspace(template.workspace).withExtension(
		'persistence',
		(ctx) => workspacePersistence(ctx),
	);
}
