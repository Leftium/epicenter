/**
 * Skill instructions documents — per-skill Y.Doc factory.
 *
 * Each skill has a markdown instruction body stored in its own Y.Doc with
 * `attachPlainText`, enabling collaborative Y.Text editing in browser-based
 * editors. The factory is workspace-scoped — apps call
 * `createSkillInstructionsDocs({ workspaceId, skillsTable })` once and reuse
 * the result.
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

type PersistenceMode = 'indexeddb' | 'none';

export function createSkillInstructionsDocs({
	workspaceId,
	skillsTable,
	persistence = 'indexeddb',
}: {
	workspaceId: string;
	skillsTable: Table<Skill>;
	persistence?: PersistenceMode;
}) {
	function buildSkillInstructionsDoc(skillId: string) {
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
			idb,
			whenReady: idb ? idb.whenLoaded : Promise.resolve(),
			whenDisposed: idb ? idb.whenDisposed : Promise.resolve(),
			[Symbol.dispose]() {
				ydoc.destroy();
			},
		};
	}

	return defineDocument(buildSkillInstructionsDoc, { gcTime: 30_000 });
}

export type SkillInstructionsDocs = ReturnType<
	typeof createSkillInstructionsDocs
>;
