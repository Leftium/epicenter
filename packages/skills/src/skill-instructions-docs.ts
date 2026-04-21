/**
 * Per-skill instructions Y.Doc factory. Each skill's markdown instruction body
 * lives in its own Y.Doc with `attachPlainText`. Persistence is caller-owned
 * via the `attach` callback — see `createFileContentDocs` for the shape.
 */

import {
	attachPlainText,
	defineDocument,
	docGuid,
	onLocalUpdate,
} from '@epicenter/document';
import type { Table } from '@epicenter/workspace';
import * as Y from 'yjs';
import type { Skill } from './tables.js';

export type ContentAttachment = {
	whenLoaded?: Promise<void>;
	whenDisposed?: Promise<void>;
};

export function createSkillInstructionsDocs({
	workspaceId,
	skillsTable,
	attach,
}: {
	workspaceId: string;
	skillsTable: Table<Skill>;
	attach?: (ydoc: Y.Doc) => ContentAttachment | void;
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

		onLocalUpdate(ydoc, () => {
			skillsTable.update(skillId, { updatedAt: Date.now() });
		});

		const attached = attach?.(ydoc);

		return {
			ydoc,
			instructions,
			whenReady: attached?.whenLoaded ?? Promise.resolve(),
			whenDisposed: attached?.whenDisposed ?? Promise.resolve(),
			[Symbol.dispose]() {
				ydoc.destroy();
			},
		};
	});
}
