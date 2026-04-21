/**
 * Per-reference content Y.Doc factory. References are tier-3 documentation
 * loaded on demand — each gets its own Y.Doc with `attachPlainText`.
 * Persistence is caller-owned via `attach`; see `buildPerRowDoc` /
 * `DocPersistence` in `@epicenter/document` for the contract.
 */

import {
	attachPlainText,
	buildPerRowDoc,
	defineDocument,
	type DocPersistence,
} from '@epicenter/document';
import type { Table } from '@epicenter/workspace';
import type * as Y from 'yjs';
import type { Reference } from './tables.js';

export function createReferenceContentDocs({
	workspaceId,
	referencesTable,
	attach,
}: {
	workspaceId: string;
	referencesTable: Table<Reference>;
	attach?: (ydoc: Y.Doc) => DocPersistence;
}) {
	return defineDocument((referenceId: string) => {
		const base = buildPerRowDoc({
			workspaceId,
			collection: 'references',
			field: 'content',
			id: referenceId,
			onUpdate: () =>
				referencesTable.update(referenceId, { updatedAt: Date.now() }),
			attach,
		});
		return { ...base, content: attachPlainText(base.ydoc) };
	});
}
