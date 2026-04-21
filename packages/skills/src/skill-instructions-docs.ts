/**
 * Skill instructions documents — per-skill Y.Doc factory.
 *
 * Each skill has a markdown instruction body stored in its own Y.Doc with
 * `attachPlainText`, enabling collaborative Y.Text editing in browser-based
 * editors. The factory is workspace-scoped — apps call
 * `createSkillInstructionsDocs(ws)` once and reuse the result.
 *
 * NOTE: Sync is deferred to a follow-up. The framework-collapse spec
 * (20260420T230100) lands IDB-only in the first pass.
 */

import {
	attachIndexedDb,
	attachPlainText,
	defineDocument,
	onLocalUpdate,
} from '@epicenter/document';
import type { Table } from '@epicenter/workspace';
import * as Y from 'yjs';
import type { Skill } from './tables.js';

type PersistenceMode = 'indexeddb' | 'none';

export function createSkillInstructionsDocs(
	skillsTable: Table<Skill>,
	workspaceId = 'skills',
	opts: { persistence?: PersistenceMode } = {},
) {
	const persistence = opts.persistence ?? 'indexeddb';

	function buildSkillInstructionsDoc(skillId: string) {
		const ydoc = new Y.Doc({
			guid: `${workspaceId}.skills.${skillId}.instructions`,
			gc: false,
		});
		const content = attachPlainText(ydoc);
		const idb = persistence === 'indexeddb' ? attachIndexedDb(ydoc) : null;

		onLocalUpdate(ydoc, () => {
			skillsTable.update(skillId, { updatedAt: Date.now() });
		});

		return {
			ydoc,
			content,
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
