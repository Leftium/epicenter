/**
 * Per-reference content Y.Doc factory. References are tier-3 documentation
 * loaded on demand — each reference file gets its own Y.Doc with
 * `attachPlainText`. Persistence is caller-owned via the `attachPersistence`
 * callback — see `createFileContentDocs` for the shape.
 */

import {
	attachPlainText,
	createPerRowDoc,
	defineDocument,
	type DocPersistence,
} from '@epicenter/workspace';
import type { Table } from '@epicenter/workspace';
import type * as Y from 'yjs';
import type { Reference } from './tables.js';

export function createReferenceContentDocs({
	workspaceId,
	referencesTable,
	attachPersistence,
}: {
	workspaceId: string;
	referencesTable: Table<Reference>;
	attachPersistence?: (ydoc: Y.Doc) => DocPersistence;
}) {
	return defineDocument((referenceId: string) => {
		const base = createPerRowDoc({
			workspaceId,
			collection: 'references',
			field: 'content',
			id: referenceId,
			onUpdate: () =>
				referencesTable.update(referenceId, { updatedAt: Date.now() }),
			attachPersistence,
		});
		return { ...base, content: attachPlainText(base.ydoc) };
	});
}
