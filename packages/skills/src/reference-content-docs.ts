/**
 * Per-reference content Y.Doc factory. References are tier-3 documentation
 * loaded on demand — each reference file gets its own Y.Doc with
 * `attachPlainText`. Persistence is caller-owned via the `attach` callback
 * — see `createFileContentDocs` for the shape.
 */

import {
	attachPlainText,
	type ContentAttachment,
	defineDocument,
	docGuid,
	onLocalUpdate,
} from '@epicenter/document';
import type { Table } from '@epicenter/workspace';
import * as Y from 'yjs';
import type { Reference } from './tables.js';

export function createReferenceContentDocs({
	workspaceId,
	referencesTable,
	attach,
}: {
	workspaceId: string;
	referencesTable: Table<Reference>;
	attach?: (ydoc: Y.Doc) => ContentAttachment | void;
}) {
	return defineDocument((referenceId: string) => {
		const ydoc = new Y.Doc({
			guid: docGuid({
				workspaceId,
				collection: 'references',
				rowId: referenceId,
				field: 'content',
			}),
			gc: false,
		});
		const content = attachPlainText(ydoc);

		onLocalUpdate(ydoc, () => {
			referencesTable.update(referenceId, { updatedAt: Date.now() });
		});

		const attached = attach?.(ydoc);

		return {
			ydoc,
			content,
			whenReady: attached?.whenLoaded ?? Promise.resolve(),
			whenDisposed: attached?.whenDisposed ?? Promise.resolve(),
			[Symbol.dispose]() {
				ydoc.destroy();
			},
		};
	});
}
