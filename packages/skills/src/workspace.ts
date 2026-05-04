import { attachEncryption } from '@epicenter/workspace';
import * as Y from 'yjs';
import { SKILLS_WORKSPACE_ID } from './constants.js';
import { referencesTable, skillsTable } from './tables.js';

export type OpenSkillsOptions = {
	workspaceId?: string;
	clientID?: number;
};

export function openSkills({
	workspaceId = SKILLS_WORKSPACE_ID,
	clientID,
}: OpenSkillsOptions = {}) {
	const ydoc = new Y.Doc({ guid: workspaceId, gc: false });
	if (clientID !== undefined) ydoc.clientID = clientID;

	const encryption = attachEncryption(ydoc);
	const tables = encryption.attachTables(ydoc, {
		skills: skillsTable,
		references: referencesTable,
	});
	const kv = encryption.attachKv(ydoc, {});

	return {
		get id() {
			return ydoc.guid;
		},
		ydoc,
		tables,
		kv,
		encryption,
		batch: (fn: () => void) => ydoc.transact(fn),
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}
