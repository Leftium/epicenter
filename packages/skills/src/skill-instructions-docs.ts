/**
 * Per-skill instructions Y.Doc builder. Pure: takes a `skillId` plus all the
 * deps the construction needs and returns a Disposable bundle. Each skill's
 * markdown instruction body lives in its own Y.Doc with `attachPlainText`.
 * Persistence is caller-owned via the `attachPersistence` callback: see
 * `createFileContentDoc` for the shape.
 *
 * Wire into a `createDisposableCache` at the workspace module scope for
 * refcount + grace.
 */

import type { Table } from '@epicenter/workspace';
import {
	attachPlainText,
	type DocPersistence,
	docGuid,
	onLocalUpdate,
} from '@epicenter/workspace';
import * as Y from 'yjs';
import type { Skill } from './tables.js';

export function createSkillInstructionsDoc({
	skillId,
	workspaceId,
	skillsTable,
	attachPersistence,
}: {
	skillId: string;
	workspaceId: string;
	skillsTable: Table<Skill>;
	attachPersistence?: (ydoc: Y.Doc) => DocPersistence;
}) {
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
}
