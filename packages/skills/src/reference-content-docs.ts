/**
 * Per-reference content Y.Doc factory. References are tier-3 documentation
 * loaded on demand — each reference file gets its own Y.Doc with
 * `attachPlainText`. Apps call
 * `createReferenceContentDocs({ workspaceId, referencesTable })` once and reuse.
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
import type { Reference } from './tables.js';

export function createReferenceContentDocs({
	workspaceId,
	referencesTable,
	persistence = 'indexeddb',
}: {
	workspaceId: string;
	referencesTable: Table<Reference>;
	persistence?: 'indexeddb' | 'none';
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
		const idb = persistence === 'indexeddb' ? attachIndexedDb(ydoc) : null;

		onLocalUpdate(ydoc, () => {
			referencesTable.update(referenceId, { updatedAt: Date.now() });
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
	});
}
