/**
 * Per-skill instructions Y.Doc factory. Each skill's markdown instruction body
 * lives in its own Y.Doc with `attachPlainText`. Apps call
 * `createSkillInstructionsDocs({ workspaceId, skillsTable })` once and reuse.
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

export function createSkillInstructionsDocs({
	workspaceId,
	skillsTable,
	persistence = 'indexeddb',
}: {
	workspaceId: string;
	skillsTable: Table<Skill>;
	persistence?: 'indexeddb' | 'none';
}) {
	return defineDocument((skillId: string) => {
		const ydoc = new Y.Doc({
			guid: docGuid({
				workspaceId,
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
			whenReady: idb ? idb.whenLoaded : Promise.resolve(),
			whenDisposed: idb ? idb.whenDisposed : Promise.resolve(),
			[Symbol.dispose]() {
				ydoc.destroy();
			},
		};
	});
}
