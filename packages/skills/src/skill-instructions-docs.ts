/**
 * Per-skill instructions Y.Doc factory. Each skill's markdown instruction body
 * lives in its own Y.Doc with `attachPlainText`. Persistence is caller-owned
 * via the `attach` callback — see `createFileContentDocs` for the shape.
 */

import {
	attachPlainText,
	buildPerRowDoc,
	defineDocument,
	type DocPersistence,
} from '@epicenter/document';
import type { Table } from '@epicenter/workspace';
import type * as Y from 'yjs';
import type { Skill } from './tables.js';

export function createSkillInstructionsDocs({
	workspaceId,
	skillsTable,
	attach,
}: {
	workspaceId: string;
	skillsTable: Table<Skill>;
	attach?: (ydoc: Y.Doc) => DocPersistence;
}) {
	return defineDocument((skillId: string) => {
		const base = buildPerRowDoc({
			workspaceId,
			collection: 'skills',
			field: 'instructions',
			id: skillId,
			onUpdate: () =>
				skillsTable.update(skillId, { updatedAt: Date.now() }),
			attach,
		});
		return { ...base, instructions: attachPlainText(base.ydoc) };
	});
}
