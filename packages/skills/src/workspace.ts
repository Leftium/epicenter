import { createWorkspace } from '@epicenter/workspace';
import { SKILLS_WORKSPACE_ID } from './constants.js';
import { referencesTable, skillsTable } from './tables.js';

export function createSkillsWorkspace({
	workspaceId = SKILLS_WORKSPACE_ID,
	clientID,
}: {
	workspaceId?: string;
	clientID?: number;
} = {}) {
	const workspace = createWorkspace({
		id: workspaceId,
		tables: {
			skills: skillsTable,
			references: referencesTable,
		},
		kv: {},
	});
	if (clientID !== undefined) workspace.ydoc.clientID = clientID;
	return workspace;
}
