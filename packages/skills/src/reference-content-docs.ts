/**
 * Reference content documents — per-reference Y.Doc factory.
 *
 * References are additional documentation loaded on demand (tier 3 in the
 * progressive disclosure model). Each reference file gets its own Y.Doc
 * for collaborative editing. The factory is workspace-scoped — apps call
 * `createReferenceContentDocs({ workspaceId, referencesTable })` once and
 * reuse the result.
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

type PersistenceMode = 'indexeddb' | 'none';

export function createReferenceContentDocs({
	workspaceId,
	referencesTable,
	persistence = 'indexeddb',
}: {
	workspaceId: string;
	referencesTable: Table<Reference>;
	persistence?: PersistenceMode;
}) {
	function buildReferenceContentDoc(referenceId: string) {
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
	}

	return defineDocument(buildReferenceContentDoc, { gcTime: 30_000 });
}

export type ReferenceContentDocs = ReturnType<
	typeof createReferenceContentDocs
>;
