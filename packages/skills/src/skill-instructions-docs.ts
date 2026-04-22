/**
 * Per-skill instructions Y.Doc factory. Each skill's markdown instruction body
 * lives in its own Y.Doc with `attachPlainText`. Persistence is caller-owned
 * via the `attachPersistence` callback — see `createFileContentDocs` for the
 * shape.
 */

import {
	attachPlainText,
	createDocumentFactory,
	docGuid,
	type DocPersistence,
	onLocalUpdate,
} from '@epicenter/workspace';
import type { Table } from '@epicenter/workspace';
import * as Y from 'yjs';
import type { Skill } from './tables.js';

export function createSkillInstructionsDocs({
	workspaceId,
	skillsTable,
	attachPersistence,
}: {
	workspaceId: string;
	skillsTable: Table<Skill>;
	attachPersistence?: (ydoc: Y.Doc) => DocPersistence;
}) {
	return createDocumentFactory((skillId: string) => {
		const ydoc = new Y.Doc({
			guid: docGuid({
				workspaceId,
				collection: 'skills',
				rowId: skillId,
				field: 'instructions',
			}),
			gc: false,
		});
		onLocalUpdate(ydoc, () =>
			skillsTable.update(skillId, { updatedAt: Date.now() }),
		);
		const persistence = attachPersistence?.(ydoc);
		return {
			ydoc,
			instructions: attachPlainText(ydoc),
			persistence,
			whenReady: persistence?.whenLoaded ?? Promise.resolve(),
			[Symbol.dispose]() {
				ydoc.destroy();
			},
		};
	});
}
