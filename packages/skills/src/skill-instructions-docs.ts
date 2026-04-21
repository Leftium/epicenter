/**
 * Per-skill instructions Y.Doc factory. Each skill's markdown instruction body
 * lives in its own Y.Doc with `attachPlainText`. Apps call
 * `createSkillInstructionsDocs(workspace)` once and reuse.
 */

import {
	attachIndexedDb,
	attachPlainText,
	defineDocument,
	docGuid,
	onLocalUpdate,
} from '@epicenter/document';
import type { Table } from '@epicenter/workspace';
import * as Y from 'yjs';
import type { Skill } from './tables.js';

export function createSkillInstructionsDocs(
	workspace: { id: string; tables: { skills: Table<Skill> } },
	{ persistence = 'indexeddb' }: { persistence?: 'indexeddb' | 'none' } = {},
) {
	const skillsTable = workspace.tables.skills;
	return defineDocument((skillId: string) => {
		const ydoc = new Y.Doc({
			guid: docGuid({
				workspaceId: workspace.id,
				collection: 'skills',
				rowId: skillId,
				field: 'instructions',
			}),
			gc: false,
		});
		const instructions = attachPlainText(ydoc);
		const idb = persistence === 'indexeddb' ? attachIndexedDb(ydoc) : null;

		onLocalUpdate(ydoc, () => {
			skillsTable.update(skillId, { updatedAt: Date.now() });
		});

		return {
			ydoc,
			instructions,
			idb,
			whenReady: idb ? idb.whenLoaded : Promise.resolve(),
			whenDisposed: idb ? idb.whenDisposed : Promise.resolve(),
			[Symbol.dispose]() {
				ydoc.destroy();
			},
		};
	});
}
