/**
 * Per-reference content Y.Doc factory. References are tier-3 documentation
 * loaded on demand — each reference file gets its own Y.Doc with
 * `attachPlainText`. Persistence is caller-owned via the `attachPersistence`
 * callback — see `createFileContentDocs` for the shape.
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
	return createDocumentFactory((referenceId: string) => {
		const ydoc = new Y.Doc({
			guid: docGuid({
				workspaceId,
				collection: 'references',
				rowId: referenceId,
				field: 'content',
			}),
			gc: false,
		});
		onLocalUpdate(ydoc, () =>
			referencesTable.update(referenceId, { updatedAt: Date.now() }),
		);
		const persistence = attachPersistence?.(ydoc);
		return {
			ydoc,
			content: attachPlainText(ydoc),
			persistence,
			whenReady: persistence?.whenLoaded ?? Promise.resolve(),
			[Symbol.dispose]() {
				ydoc.destroy();
			},
		};
	});
}
